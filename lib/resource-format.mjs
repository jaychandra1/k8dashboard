// The list-row shape of a Kubernetes object, shared by server.js (real
// clusters) and demo.js (the synthetic one) so both lists always match:
// name / namespace / kind / createdAt / status plus the per-kind columns the
// resource tables show (client/src/components/resources/columns.jsx).

// Derive a simple status for a single container from its containerStatus.
// running -> 'running', waiting(bad reason)/terminated(non-zero) -> 'failed',
// waiting(other) -> 'pending', missing status -> 'unknown'
export function containerState(cs) {
  if (!cs || !cs.state) return 'unknown';
  if (cs.state.running) return 'running';
  if (cs.state.terminated) {
    return cs.state.terminated.exitCode === 0 ? 'running' : 'failed';
  }
  if (cs.state.waiting) {
    const reason = cs.state.waiting.reason || '';
    const bad = /CrashLoopBackOff|Error|ImagePull|InvalidImageName|CreateContainer|RunContainer|CreateContainerConfigError/i.test(reason);
    return bad ? 'failed' : 'pending';
  }
  return 'unknown';
}

export function formatResource(item, kind) {
  const resolvedKind = kind || item.kind;
  const out = {
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    kind: resolvedKind,
    createdAt: item.metadata.creationTimestamp,
    status: getResourceStatus(item, resolvedKind)
  };
  if (resolvedKind === 'Pod') {
    out.phase = item.status?.phase || 'Unknown';
    out.node = item.spec?.nodeName || null;
    out.containerNames = (item.spec?.containers || []).map(c => c.name);
    const cs = item.status?.containerStatuses || [];
    const byName = {};
    cs.forEach(c => { byName[c.name] = c; });
    out.containerStates = (item.spec?.containers || []).map(c => ({
      name: c.name,
      status: containerState(byName[c.name])
    }));
    out.containers = out.containerNames.length || cs.length;
    out.restarts = cs.reduce((s, c) => s + (c.restartCount || 0), 0);
  }
  const controller = (item.metadata?.ownerReferences || []).find((o) => o.controller) || null;
  if (resolvedKind === 'ReplicaSet' || resolvedKind === 'ReplicationController') {
    out.desired = item.spec?.replicas ?? 0;
    out.current = item.status?.replicas ?? 0;
    out.ready = item.status?.readyReplicas ?? 0;
    out.owner = controller ? `${controller.kind} ${controller.name}` : '';
  }
  if (resolvedKind === 'Job') {
    const st = item.status || {};
    out.completions = `${st.succeeded || 0}/${item.spec?.completions ?? 1}`;
    const start = Date.parse(st.startTime || '');
    const end = Date.parse(st.completionTime || '')
      || Date.parse((st.conditions || []).find((c) => c.type === 'Failed' && c.status === 'True')?.lastTransitionTime || '');
    out.durationSeconds = Number.isFinite(start) ? Math.max(0, Math.round(((Number.isFinite(end) ? end : Date.now()) - start) / 1000)) : null;
    out.owner = controller ? `${controller.kind} ${controller.name}` : '';
  }
  if (resolvedKind === 'CronJob') {
    out.schedule = item.spec?.schedule || '';
    out.timeZone = item.spec?.timeZone || '';
    out.suspend = !!item.spec?.suspend;
    out.activeJobs = (item.status?.active || []).length;
    out.lastSchedule = item.status?.lastScheduleTime || null;
    out.lastSuccess = item.status?.lastSuccessfulTime || null;
  }
  if (resolvedKind === 'ConfigMap') {
    out.dataKeys = Object.keys(item.data || {}).length + Object.keys(item.binaryData || {}).length;
  }
  if (resolvedKind === 'Secret') {
    out.secretType = item.type || 'Opaque';
    out.dataKeys = Object.keys(item.data || {}).length;
  }
  if (resolvedKind === 'Service') {
    out.serviceType = item.spec?.type || 'ClusterIP';
    // "80/TCP, 443:30443/TCP" like kubectl's PORT(S); no addresses.
    out.ports = (item.spec?.ports || []).map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol || 'TCP'}`).join(', ');
  }
  if (resolvedKind === 'ServiceAccount') {
    out.saSecrets = (item.secrets || []).length;
  }
  if (resolvedKind === 'NetworkPolicy') {
    out.policyTypes = (item.spec?.policyTypes || []).join(', ') || '-';
  }
  if (resolvedKind === 'Ingress') {
    out.ingressClass = item.spec?.ingressClassName || '-';
    out.hosts = (item.spec?.rules || []).map(r => r.host).filter(Boolean).join(', ') || '-';
  }
  if (resolvedKind === 'PersistentVolumeClaim') {
    out.capacity = item.status?.capacity?.storage || item.spec?.resources?.requests?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.volume = item.spec?.volumeName || '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'PersistentVolume') {
    out.capacity = item.spec?.capacity?.storage || '-';
    out.storageClass = item.spec?.storageClassName || '-';
    out.reclaimPolicy = item.spec?.persistentVolumeReclaimPolicy || '-';
    out.claim = item.spec?.claimRef ? `${item.spec.claimRef.namespace}/${item.spec.claimRef.name}` : '-';
    out.accessModes = (item.spec?.accessModes || []).join(',') || '-';
  }
  if (resolvedKind === 'StorageClass') {
    out.provisioner = item.provisioner || '-';
    out.reclaimPolicy = item.reclaimPolicy || 'Delete';
    out.bindingMode = item.volumeBindingMode || 'Immediate';
  }
  return out;
}

// `kind` is passed explicitly because list items from the client library
// don't carry a per-item `kind` field.
/**
 * A pod's STATUS the way `kubectl get pods` prints it: the phase, unless a
 * container explains more — CrashLoopBackOff, ImagePullBackOff, OOMKilled,
 * Completed, Init:0/2, Init:Error, Terminating. The phase alone said
 * "Running" for a pod whose container was crash-looping.
 */
export function podStatus(item) {
  const st = item.status || {};
  let reason = st.reason || st.phase || 'Unknown';
  const initSpecs = item.spec?.initContainers || [];
  let initializing = false;
  (st.initContainerStatuses || []).some((c, i) => {
    const t = c.state?.terminated;
    if (t && t.exitCode === 0) return false;
    // Native sidecars (restartPolicy: Always) keep running; they don't block.
    if (c.state?.running && initSpecs.find((s) => s.name === c.name)?.restartPolicy === 'Always') return false;
    if (t) reason = t.reason ? `Init:${t.reason}` : (t.signal ? `Init:Signal:${t.signal}` : `Init:ExitCode:${t.exitCode}`);
    else if (c.state?.waiting?.reason && c.state.waiting.reason !== 'PodInitializing') reason = `Init:${c.state.waiting.reason}`;
    else reason = `Init:${i}/${initSpecs.length || (st.initContainerStatuses || []).length}`;
    initializing = true;
    return true;
  });
  if (!initializing) {
    let hasRunning = false;
    const cs = st.containerStatuses || [];
    for (let i = cs.length - 1; i >= 0; i--) {
      const s = cs[i].state || {};
      if (s.waiting?.reason) reason = s.waiting.reason;
      else if (s.terminated?.reason) reason = s.terminated.reason;
      else if (s.terminated) reason = s.terminated.signal ? `Signal:${s.terminated.signal}` : `ExitCode:${s.terminated.exitCode}`;
      else if (cs[i].ready && s.running) hasRunning = true;
    }
    if (reason === 'Completed' && hasRunning) {
      const ready = (st.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
      reason = ready ? 'Running' : 'NotReady';
    }
  }
  if (item.metadata?.deletionTimestamp) reason = st.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
  return reason;
}

export function getResourceStatus(item, kind) {
  const status = item.status || {};
  if (kind === 'Pod') {
    return podStatus(item);
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
    const ready = status.readyReplicas != null ? status.readyReplicas
      : (status.numberReady != null ? status.numberReady : 0);
    const desired = status.replicas != null ? status.replicas
      : (status.desiredNumberScheduled != null ? status.desiredNumberScheduled : 0);
    return `${ready}/${desired}`;
  }
  if (kind === 'ReplicaSet' || kind === 'ReplicationController') {
    return `${status.readyReplicas || 0}/${item.spec?.replicas ?? status.replicas ?? 0}`;
  }
  if (kind === 'Job') {
    const cond = (type) => (status.conditions || []).some((c) => c.type === type && c.status === 'True');
    if (cond('Complete')) return 'Complete';
    if (cond('Failed')) return 'Failed';
    if (item.spec?.suspend) return 'Suspended';
    return (status.active || 0) > 0 ? 'Running' : 'Pending';
  }
  if (kind === 'CronJob') {
    if (item.spec?.suspend) return 'Suspended';
    return (status.active || []).length ? 'Active' : 'Scheduled';
  }
  if (kind === 'Service') {
    return item.spec?.type || 'Unknown';
  }
  if (kind === 'PersistentVolume' || kind === 'PersistentVolumeClaim') {
    return status.phase || 'Unknown';
  }
  if (kind === 'StorageClass') {
    return '';
  }
  return 'Unknown';
}
