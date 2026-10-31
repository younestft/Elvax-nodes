import { app } from "/scripts/app.js";
import { api, PromptExecutionError } from "/scripts/api.js";

const NODE_TYPE = "ElvaxGenerationQueueManager";
const POLL_INTERVAL_MS = 2500;
const MIN_WIDGET_HEIGHT = 360;
const MIN_NODE_WIDTH = 360;
const QUEUE_DB_NAME = "elvax-generation-queue-manager";
const QUEUE_DB_STORE = "state";
const QUEUE_JOBS_STORE = "jobs";
const QUEUE_STATE_KEY = "paused-queue";
const nodeViews = new Set();
let pollTimer = null;
let refreshTimer = null;
let refreshInProgress = false;
let serverQueueItems = [];
let queueState = { pausedWorkflowIds: [], jobs: [] };
let queueActionInProgress = false;
const queueSupported = typeof navigator.locks?.request === "function" && typeof crypto.randomUUID === "function" &&
  typeof indexedDB !== "undefined" && typeof BroadcastChannel === "function";
let queueStateError = queueSupported ? null : new Error("Generation Queue Manager requires secure browser features. Open ComfyUI using localhost or HTTPS.");
let queueStorageReady = false;
let submitQueuePrompt = null;
let savedJobs = new Map();
let savedJobVersions = {};
let queueStateWrites = Promise.resolve();
let pollingStarted = false;
const queueChannel = queueSupported ? new BroadcastChannel(QUEUE_DB_NAME) : null;

const queueDbReady = queueSupported ? new Promise((resolve, reject) => {
  const request = indexedDB.open(QUEUE_DB_NAME, 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(QUEUE_DB_STORE)) db.createObjectStore(QUEUE_DB_STORE);
    const jobs = db.createObjectStore(QUEUE_JOBS_STORE);
    const state = request.transaction.objectStore(QUEUE_DB_STORE);
    const previous = state.get(QUEUE_STATE_KEY);
    previous.onsuccess = () => {
      const stored = previous.result;
      if (!stored?.jobs) return;
      for (const job of stored.jobs) jobs.put(job.promptId ? { ...job, transferPending: true } : job, job.key);
      state.put({ pausedWorkflowIds: [], jobKeys: stored.jobs.map((job) => job.key) }, QUEUE_STATE_KEY);
    };
  };
  request.onsuccess = () => {
    if (queueStateError) request.result.close();
    else resolve(request.result);
  };
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("Close other ComfyUI windows, then refresh to update saved queue storage."));
}).then(async (db) => {
  db.onversionchange = () => db.close();
  await loadQueueState(db);
  queueStorageReady = true;
  return db;
}).catch((error) => {
  queueStateError = error;
  return null;
}) : Promise.resolve(null);
queueDbReady.then(renderQueueViews);

async function loadQueueState(db) {
  await new Promise((resolve, reject) => {
    const transaction = db.transaction([QUEUE_DB_STORE, QUEUE_JOBS_STORE], "readonly");
    const state = transaction.objectStore(QUEUE_DB_STORE).get(QUEUE_STATE_KEY);
    const jobs = new Map();
    state.onsuccess = () => {
      for (const key of state.result?.jobKeys || []) {
        if (savedJobs.has(key) && savedJobVersions[key] === state.result?.jobVersions?.[key]) {
          jobs.set(key, savedJobs.get(key));
        } else {
          const request = transaction.objectStore(QUEUE_JOBS_STORE).get(key);
          request.onsuccess = () => { if (request.result) jobs.set(key, request.result); };
        }
      }
    };
    transaction.oncomplete = () => {
      savedJobs = jobs;
      savedJobVersions = state.result?.jobVersions || {};
      if (state.result) queueState = { pausedWorkflowIds: state.result.pausedWorkflowIds || [],
        jobs: (state.result.jobKeys || []).map((key) => savedJobs.get(key)).filter(Boolean) };
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Saved queue storage was cancelled."));
  });
}

if (queueChannel) queueChannel.onmessage = () => {
  const reload = queueStateWrites.then(() => navigator.locks.request(`${QUEUE_DB_NAME}-state`, async () => {
    const db = await queueDbReady;
    if (!db) return;
    await loadQueueState(db);
    renderQueueViews();
  }));
  queueStateWrites = reload.catch(() => {});
};

async function runQueueAction(view, action) {
  const workflowId = app.graph.id;
  try {
    if (!queueSupported) throw queueStateError;
    return await navigator.locks.request(`${QUEUE_DB_NAME}-action`, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        view.error.textContent = "Another window is updating the queue. Try again shortly.";
        view.error.style.display = "block";
        return;
      }
      const db = await queueDbReady;
      if (!db) throw queueStateError || new Error("Saved queue storage is unavailable.");
      await queueStateWrites;
      await navigator.locks.request(`${QUEUE_DB_NAME}-state`, () => loadQueueState(db));
      if (app.graph.id !== workflowId || !view.root.isConnected) return;
      await action();
    });
  } catch (error) {
    view.actionError = `Could not update queue: ${error.message || "request failed"}`;
    view.error.textContent = view.actionError;
    view.error.style.display = "block";
    updateAllQueueControls();
  }
}

async function persistQueueState(next) {
  const db = await queueDbReady;
  if (!db) throw queueStateError || new Error("Persistent queue storage is unavailable.");
  const jobVersions = Object.fromEntries(next.jobs.map((job) => [job.key,
    savedJobs.get(job.key) === job ? savedJobVersions[job.key] : crypto.randomUUID()]));
  await new Promise((resolve, reject) => {
    const transaction = db.transaction([QUEUE_DB_STORE, QUEUE_JOBS_STORE], "readwrite");
    const jobs = transaction.objectStore(QUEUE_JOBS_STORE);
    const nextJobs = new Map(next.jobs.map((job) => [job.key, job]));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Saved queue storage was cancelled."));
    try {
      for (const [key, job] of nextJobs) if (savedJobs.get(key) !== job) jobs.put(job, key);
      for (const key of savedJobs.keys()) if (!nextJobs.has(key)) jobs.delete(key);
      transaction.objectStore(QUEUE_DB_STORE).put({ pausedWorkflowIds: next.pausedWorkflowIds, jobKeys: [...nextJobs.keys()], jobVersions }, QUEUE_STATE_KEY);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
  savedJobs = new Map(next.jobs.map((job) => [job.key, job]));
  savedJobVersions = jobVersions;
}

function changeQueueState(update) {
  const operation = queueStateWrites.then(() => navigator.locks.request(`${QUEUE_DB_NAME}-state`, async () => {
    const db = await queueDbReady;
    if (!db) throw queueStateError;
    await loadQueueState(db);
    const next = update(queueState);
    if (next === queueState) return;
    await persistQueueState(next);
    queueState = next;
    renderQueueViews();
    queueChannel.postMessage("changed");
  }));
  queueStateWrites = operation.catch(() => {});
  return operation;
}

function queueWorkflowId(workflow) {
  if (!workflow?.nodes?.some((node) => node?.type === NODE_TYPE)) return null;
  return typeof workflow.id === "string" && workflow.id ? workflow.id : null;
}

function workflowJobs(workflowId) {
  return queueState.jobs.filter((job) => workflowId && job.workflow?.id === workflowId);
}

function workflowQueueItems(workflowId) {
  return serverQueueItems.filter((item) => workflowId && queueWorkflowId(item.extraData?.extra_pnginfo?.workflow) === workflowId);
}

function resumeWorkflow(state, workflowId) {
  return { ...state, pausedWorkflowIds: state.pausedWorkflowIds.filter((id) => id !== workflowId) };
}

function makeQueueSnapshot(tuple) {
  const extraData = tuple[3] || {};
  return {
    key: `paused-${tuple[1]}`,
    promptId: tuple[1],
    number: tuple[0],
    transferPending: true,
    prompt: tuple[2] || {},
    workflow: extraData.extra_pnginfo?.workflow || null,
    options: {
      ...(Array.isArray(tuple[4]) && tuple[4].length ? { partialExecutionTargets: tuple[4] } : {}),
      ...(extraData.preview_method ? { previewMethod: extraData.preview_method } : {}),
    },
  };
}

function installQueuePauseHook() {
  if (!queueSupported) return;
  if (api.__elvaxQueuePauseHook) {
    submitQueuePrompt = api.__elvaxQueuePauseHook;
    return;
  }
  const originalQueuePrompt = api.queuePrompt;
  if (typeof originalQueuePrompt !== "function") return;
  submitQueuePrompt = originalQueuePrompt;
  api.__elvaxQueuePauseHook = originalQueuePrompt;
  api.queuePrompt = async function (number, promptData, options) {
    const workflowId = queueWorkflowId(promptData?.workflow);
    if (!workflowId) {
      return originalQueuePrompt.call(this, number, promptData, options);
    }
    return navigator.locks.request(`${QUEUE_DB_NAME}-submission`, { mode: "shared" }, async () => {
      await queueDbReady;
      let saved = false;
      try {
        await changeQueueState((state) => {
          if (!state.pausedWorkflowIds.includes(workflowId)) return state;
          const job = {
            key: `paused-${crypto.randomUUID()}`,
            promptId: null,
            number,
            prompt: structuredClone(promptData?.output || {}),
            workflow: structuredClone(promptData?.workflow || null),
            options: structuredClone(options || {}),
          };
          saved = true;
          return { ...state, jobs: [...state.jobs, job] };
        });
      } catch (error) {
        if (queueState.pausedWorkflowIds.includes(workflowId)) throw error;
        app.extensionManager?.toast?.add({
          severity: "warn",
          summary: "Could not save job",
          detail: "Sending this job directly to ComfyUI.",
          life: 4000,
        });
      }
      if (saved) {
        app.extensionManager?.toast?.add({
          severity: "info",
          summary: "Job paused",
          detail: "Resume the job when you are ready to run it.",
          life: 4000,
        });
        return { node_errors: {} };
      }
      return originalQueuePrompt.call(this, number, promptData, options);
    });
  };
}

installQueuePauseHook();

function updateQueueControls(view) {
  const workflowId = app.graph.id;
  const items = workflowQueueItems(workflowId);
  const jobs = workflowJobs(workflowId);
  const paused = queueState.pausedWorkflowIds.includes(workflowId);
  const unavailable = queueActionInProgress || !queueSupported;
  for (const button of view.running.querySelectorAll("button")) button.disabled = unavailable;
  view.pauseButton.disabled = unavailable || !queueStorageReady || !!queueStateError ||
    !items.some((item) => item.state === "Queued");
  view.resumeButton.disabled = unavailable || !queueStorageReady || !!queueStateError || (!jobs.length && !paused);
  view.resumeButton.title = paused && !jobs.length ? "Resume new submissions" : "Resume all paused jobs in this workflow";
  view.resumeButton.setAttribute("aria-label", view.resumeButton.title);
  view.removeAllButton.disabled = unavailable || !queueStorageReady || !!queueStateError || (!items.some((item) => item.state === "Queued") && !jobs.length);
  view.queuedCount.textContent = String(items.filter((item) => item.state === "Queued").length);
  view.pausedCount.textContent = String(jobs.length);
  for (const button of view.list.querySelectorAll("[data-paused-job]")) {
    button.disabled = unavailable;
  }
  for (const button of view.list.querySelectorAll("[data-reorder-job]")) {
    button.disabled = unavailable || button.dataset.atLimit === "true";
  }
  for (const button of view.list.querySelectorAll("[data-queue-pause], [data-queue-cancel]")) button.disabled = unavailable;
}

function updateAllQueueControls() {
  for (const view of nodeViews) updateQueueControls(view);
}

async function pauseQueue(view) {
  if (queueActionInProgress) return;
  const workflowId = app.graph.id;
  queueActionInProgress = true;
  view.actionError = "";
  updateAllQueueControls();
  try {
    await queueDbReady;
    if (!submitQueuePrompt) throw new Error("ComfyUI prompt submission is not available.");
    await changeQueueState((state) => state.pausedWorkflowIds.includes(workflowId) ? state :
      { ...state, pausedWorkflowIds: [...state.pausedWorkflowIds, workflowId] });
    await navigator.locks.request(`${QUEUE_DB_NAME}-submission`, () => {});

    const response = await api.fetchApi("/queue");
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
    const queue = await response.json();
    const pending = (queue.queue_pending || []).filter((tuple) => queueWorkflowId(tuple[3]?.extra_pnginfo?.workflow) === workflowId);
    const knownIds = new Set(queueState.jobs.map((job) => job.promptId).filter(Boolean));
    const newJobs = pending.slice().sort((a, b) => a[0] - b[0])
      .filter((tuple) => !knownIds.has(tuple[1])).map(makeQueueSnapshot);
    await changeQueueState((state) => ({ ...state, jobs: [...newJobs, ...state.jobs] }));
    await finishQueueTransfers(workflowId);
    view.signature = null;
    refreshQueue();
  } catch (error) {
    view.actionError = `Could not pause queue: ${error.message || "request failed"}`;
    view.error.textContent = view.actionError;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function finishQueueTransfers(workflowId) {
  const jobs = workflowJobs(workflowId).filter((job) => job.transferPending);
  if (!jobs.length) return;
  const response = await api.fetchApi("/elvax/generation-queue-manager/pause", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_id: workflowId, prompt_ids: jobs.map((job) => job.promptId) }),
  });
  if (!response.ok) throw new Error("Could not confirm which jobs were paused. Try Resume again.");
  const paused = new Set((await response.json()).paused);
  const keys = new Set(jobs.map((job) => job.key));
  await changeQueueState((state) => ({ ...state, jobs: state.jobs.flatMap((job) =>
    !keys.has(job.key) ? [job] : paused.has(job.promptId) ? [{ ...job, transferPending: false }] : []) }));
}

async function resumeQueue(view, jobKey = null) {
  if (queueActionInProgress) return;
  const workflowId = app.graph.id;
  queueActionInProgress = true;
  view.actionError = "";
  updateAllQueueControls();
  try {
    await queueDbReady;
    await finishStoppedJobs(workflowId);
    await finishQueueTransfers(workflowId);
    while (true) {
      const jobs = workflowJobs(workflowId);
      if (jobKey && !jobs.some((job) => job.key === jobKey)) break;
      if (!jobs.length) {
        await changeQueueState((state) => state.jobs.some((job) => job.workflow?.id === workflowId) ? state : resumeWorkflow(state, workflowId));
        if (!workflowJobs(workflowId).length) break;
        continue;
      }
      let job = jobKey ? jobs.find((item) => item.key === jobKey) : jobs[0];
      if (job.submitting) {
        const response = await api.fetchApi("/elvax/generation-queue-manager/submitted", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_key: job.key }),
        });
        if (!response.ok) throw new Error("Could not check the previous submission. Try again.");
        if (!(await response.json()).submitted) {
          const message = "The previous submission could not be confirmed. Retry this job? It may run twice if the earlier request succeeds.";
          const confirmed = app.extensionManager?.dialog?.confirm
            ? await app.extensionManager.dialog.confirm({ title: "Retry job?", message })
            : window.confirm(message);
          if (!confirmed) return;
          const check = await api.fetchApi("/elvax/generation-queue-manager/submitted", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_key: job.key }),
          });
          if (!check.ok) throw new Error("Could not check the previous submission. Try again.");
          if (!(await check.json()).submitted) {
            await changeQueueState((state) => ({ ...state, jobs: state.jobs.map((item) =>
              item.key === job.key ? { ...item, submitting: false } : item) }));
            continue;
          }
        }
      } else {
        job = { ...job, submitting: true };
        await changeQueueState((state) => ({ ...state, jobs: state.jobs.map((item) => item.key === job.key ? job : item) }));
        try {
          await submitQueuePrompt.call(api, 0, {
            output: job.prompt,
            workflow: { ...job.workflow, extra: { ...job.workflow?.extra, elvaxQueueJobKey: job.key } },
          }, job.options || {});
        } catch (error) {
          if (error instanceof PromptExecutionError && error.status >= 400 && error.status < 500) {
            await changeQueueState((state) => ({ ...state, jobs: state.jobs.map((item) => item.key === job.key ? { ...item, submitting: false } : item) }));
          }
          throw error;
        }
      }
      await changeQueueState((state) => ({ ...state, jobs: state.jobs.filter((item) => item.key !== job.key) }));
      if (jobKey) {
        await changeQueueState((state) => state.jobs.some((job) => job.workflow?.id === workflowId) ? state : resumeWorkflow(state, workflowId));
        break;
      }
    }
    view.signature = null;
    refreshQueue();
  } catch (error) {
    view.actionError = `Could not resume queue: ${error.message || "request failed"}`;
    view.error.textContent = view.actionError;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function removeAllJobs(view) {
  if (queueActionInProgress) return;
  const workflowId = app.graph.id;
  const message = "Cancel all queued and paused jobs in this workflow? The running job will continue. This cannot be undone.";
  const confirmed = app.extensionManager?.dialog?.confirm
    ? await app.extensionManager.dialog.confirm({ title: "Cancel queued and paused jobs?", message })
    : window.confirm(message);
  if (!confirmed || queueActionInProgress) return;
  queueActionInProgress = true;
  updateAllQueueControls();
  const keys = new Set(workflowJobs(workflowId).map((job) => job.key));
  try {
    const response = await api.fetchApi("/elvax/generation-queue-manager/cancel-pending", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow_id: workflowId }),
    });
    if (!response.ok) throw new Error("Could not cancel queued jobs.");
    await changeQueueState((state) => {
      const jobs = state.jobs.filter((job) => !keys.has(job.key));
      return resumeWorkflow({ ...state, jobs }, workflowId);
    });
    view.actionError = "";
    refreshQueue();
  } catch (error) {
    view.actionError = `Could not cancel queued jobs: ${error.message || "request failed"}`;
    view.error.textContent = view.actionError;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function finishStoppedJobs(workflowId) {
  for (const job of workflowJobs(workflowId).filter((item) => item.stopPending)) {
    const response = await api.fetchApi(`/api/jobs/${encodeURIComponent(job.promptId)}/cancel`, { method: "POST" });
    if (!response.ok) throw new Error("Could not stop the running job. Try again.");
    const { cancelled } = await response.json();
    let completed = false;
    if (!cancelled) {
      const history = await api.fetchApi(`/history/${encodeURIComponent(job.promptId)}`);
      if (!history.ok) throw new Error("Could not check whether the job stopped. Its saved copy has been kept.");
      completed = (await history.json())[job.promptId]?.status?.completed === true;
    }
    await changeQueueState((state) => ({ ...state, jobs: completed ? state.jobs.filter((item) => item.key !== job.key) :
      state.jobs.map((item) => item.key === job.key ? { ...item, stopPending: false } : item) }));
  }
}

async function stopRunningJob(item, view) {
  if (queueActionInProgress) return;
  const workflowId = app.graph.id;
  if (!queueState.pausedWorkflowIds.includes(workflowId)) {
    await pauseQueue(view);
    if (view.actionError) return;
  }
  queueActionInProgress = true;
  updateAllQueueControls();
  try {
    await finishQueueTransfers(workflowId);
    const job = { ...makeQueueSnapshot(item.tuple), transferPending: false, stopPending: true };
    await changeQueueState((state) => ({ ...state, jobs: [job, ...state.jobs.filter((saved) => saved.key !== job.key)] }));
    await finishStoppedJobs(workflowId);
    view.actionError = "";
    refreshQueue();
  } catch (error) {
    view.actionError = `Could not stop job: ${error.message || "request failed"}`;
    view.error.textContent = view.actionError;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function removePausedJob(job, view) {
  if (queueActionInProgress) throw new Error("Wait for the queue action to finish before cancelling an item.");
  await changeQueueState((state) => {
    const jobs = state.jobs.filter((candidate) => candidate.key !== job.key);
    const workflowId = job.workflow?.id;
    return jobs.some((item) => item.workflow?.id === workflowId) ? { ...state, jobs } : resumeWorkflow({ ...state, jobs }, workflowId);
  });
  view.actionError = "";
  view.signature = null;
  refreshQueue();
}

async function pauseQueuedJob(item, view) {
  if (queueActionInProgress) return;
  queueActionInProgress = true;
  updateAllQueueControls();
  try {
    const job = makeQueueSnapshot(item.tuple);
    await changeQueueState((state) => ({ ...state,
      jobs: [...state.jobs.filter((saved) => saved.key !== job.key), job] }));
    await finishQueueTransfers(job.workflow?.id);
    view.actionError = "";
    refreshQueue();
  } catch (error) {
    view.actionError = `Could not pause job: ${error.message || "request failed"}`;
    view.error.textContent = view.actionError;
    view.error.style.display = "block";
  } finally {
    queueActionInProgress = false;
    updateAllQueueControls();
  }
}

async function movePausedJob(job, direction) {
  if (queueActionInProgress) return;
  await changeQueueState((state) => {
    const ownJobs = state.jobs.filter((item) => item.workflow?.id === job.workflow?.id);
    const ownIndex = ownJobs.findIndex((item) => item.key === job.key);
    const target = ownJobs[ownIndex + direction];
    if (ownIndex < 0 || !target) return state;
    const current = state.jobs.findIndex((candidate) => candidate.key === job.key);
    const nextIndex = state.jobs.indexOf(target);
    const jobs = state.jobs.slice();
    [jobs[current], jobs[nextIndex]] = [jobs[nextIndex], jobs[current]];
    return { ...state, jobs };
  });
}

function nodeOrder(prompt, extraData) {
  const workflowNodes = extraData?.extra_pnginfo?.workflow?.nodes || [];
  const ids = workflowNodes.map((node) => String(node.id));
  for (const id of Object.keys(prompt || {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => [id, prompt?.[id]]).filter(([, node]) => node);
}

function findFirstImage(prompt, extraData) {
  for (const [id, node] of nodeOrder(prompt, extraData)) {
    if (!/load[\w]*image/i.test(node.class_type || "")) continue;
    const workflowNode = (extraData?.extra_pnginfo?.workflow?.nodes || [])
      .find((candidate) => String(candidate.id) === id);
    const value = node.inputs?.image ?? workflowNode?.widgets_values?.[0];
    let filename = value;
    let subfolder = node.inputs?.subfolder || "";
    let type = node.inputs?.type || "input";
    if (value && typeof value === "object") {
      filename = value.filename || value.name || value.asset_hash;
      subfolder = value.subfolder ?? subfolder;
      type = value.type ?? type;
    }
    if (typeof filename !== "string" || !filename.trim()) continue;

    const match = filename.match(/^(.*?)(?:\s+\[(input|output|temp)\])?$/i);
    filename = match?.[1] || filename;
    const pathParts = filename.replace(/\\/g, "/").split("/");
    if (pathParts.length > 1 && !subfolder) {
      subfolder = pathParts.slice(0, -1).join("/");
      filename = pathParts[pathParts.length - 1];
    }
    return {
      filename,
      type: (match?.[2] || type).toLowerCase(),
      subfolder,
    };
  }
  return null;
}

function resolveText(value, prompt, seen = new Set()) {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value) || value.length < 2) return null;

  const sourceId = String(value[0]);
  if (seen.has(sourceId)) return null;
  const source = prompt?.[sourceId];
  if (!source) return null;

  const nextSeen = new Set(seen).add(sourceId);
  const sourceInputs = source.inputs || {};
  for (const key of ["text", "prompt", "positive", "string", "value", "source"]) {
    const text = resolveText(sourceInputs[key], prompt, nextSeen);
    if (text) return text;
  }
  return null;
}

function findFirstPrompt(prompt, extraData) {
  for (const [, node] of nodeOrder(prompt, extraData)) {
    if (!/(cliptextencode|text.*multiline|prompt)/i.test(node.class_type || "")) continue;
    const inputs = node.inputs || {};
    for (const key of ["text", "prompt", "positive", "string", "value", "source"]) {
      const text = resolveText(inputs[key], prompt);
      if (text) return text;
    }
  }
  return null;
}

function queueItem(tuple, state) {
  return {
    tuple,
    promptId: tuple[1],
    prompt: tuple[2] || {},
    extraData: tuple[3] || {},
    state,
  };
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionIcon(button, name, title) {
  const paths = {
    pause: '<rect x="7" y="5" width="3" height="14" rx=".8" fill="currentColor" stroke="none"/><rect x="14" y="5" width="3" height="14" rx=".8" fill="currentColor" stroke="none"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx=".8" fill="currentColor" stroke="none"/>',
    up: '<path d="m7 14 5-5 5 5"/>',
    down: '<path d="m7 10 5 5 5-5"/>',
    remove: '<path d="m18 6-12 12M6 6l12 12"/>',
  };
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  button.dataset.action = name;
  button.title = title;
  button.setAttribute("aria-label", title);
}

function addStyles() {
  if (document.getElementById(`${NODE_TYPE}-styles`)) return;
  const style = document.createElement("style");
  style.id = `${NODE_TYPE}-styles`;
  style.textContent = `
    .elvax-generation-queue { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: ${MIN_WIDGET_HEIGHT}px; box-sizing: border-box; overflow: hidden; padding: 9px; color: var(--fg-color, #eee); background: var(--comfy-input-bg, #222); font: 12px/1.4 sans-serif; }
    .elvax-generation-queue__header { display: flex; flex: 0 0 auto; flex-direction: column; gap: 7px; margin: 0 2px 5px; padding: 2px 0 9px; border-bottom: 1px solid var(--border-color, #444); }
    .elvax-generation-queue__heading, .elvax-generation-queue__controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .elvax-generation-queue__heading { flex: 1; gap: 12px; padding: 3px 0; font-size: 12px; line-height: 1.4; font-weight: 500; white-space: nowrap; flex-wrap: wrap; }
    .elvax-generation-queue__stat { display: flex; align-items: center; gap: 5px; }
    .elvax-generation-queue__stat--queued { color: #b8b8b8; }
    .elvax-generation-queue__stat--paused { color: #edc966; }
    .elvax-generation-queue__count { font-variant-numeric: tabular-nums; }
    .elvax-generation-queue__state { color: var(--descrip-text, #aaa); }
    .elvax-generation-queue__controls { justify-content: space-between; }
    .elvax-generation-queue__toolbar { display: flex; gap: 6px; flex-shrink: 0; padding: 4px; background: #1b1b1b; border: 1px solid #ffffff0d; border-radius: 9px; }
    .elvax-generation-queue button[data-action] { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 30px; box-sizing: border-box; width: 30px; height: 30px; padding: 6px; border: 1px solid #ffffff12; border-radius: 6px; background: #2b2b2b; color: #c4c4c4; cursor: pointer; transition: background .15s, border-color .15s; }
    .elvax-generation-queue button[data-action] svg { display: block; width: 17px; height: 17px; flex-shrink: 0; pointer-events: none; }
    .elvax-generation-queue button[data-action="pause"] { color: #edc966; background: #d7ab3112; border-color: #d7ab3133; }
    .elvax-generation-queue button[data-action="play"] { color: #83d9b0; background: #49ae7d12; border-color: #49ae7d33; }
    .elvax-generation-queue button[data-action="stop"] { color: #efa565; background: #df873512; border-color: #df873533; }
    .elvax-generation-queue button[data-action="remove"] { color: #d9979e; background: transparent; }
    .elvax-generation-queue button[data-action]:hover:not(:disabled) { background: #ffffff12; border-color: currentColor; }
    .elvax-generation-queue button[data-action]:disabled { opacity: .3; cursor: not-allowed; }
    .elvax-generation-queue__list { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
    .elvax-generation-queue__item { margin: 0 0 8px; padding: 10px; border: 1px solid #ffffff0d; border-radius: 9px; background: #202020; }
    .elvax-generation-queue__item--running { margin: 4px 0; padding: 8px; border: 1px solid #37624a; border-left: 3px solid #55bd7b; border-radius: 6px; background: linear-gradient(100deg, rgba(38, 98, 62, .24), rgba(38, 98, 62, .08)); }
    .elvax-generation-queue__item-header { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
    .elvax-generation-queue__state-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #999; }
    .elvax-generation-queue__state-dot--running { background: #70e59a; box-shadow: 0 0 7px rgba(112, 229, 154, .65); }
    .elvax-generation-queue__state--running { color: #8ce9aa; font-weight: 600; }
    .elvax-generation-queue__number { font-weight: 600; }
    .elvax-generation-queue__item-actions { display: flex; gap: 4px; margin-left: auto; }
    .elvax-generation-queue__cancel { margin-left: auto; }
    .elvax-generation-queue__body { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 8px; }
    .elvax-generation-queue__thumb { display: grid; width: 68px; height: 60px; place-items: center; overflow: hidden; border-radius: 4px; color: #aaa; background: #181818; font-size: 10px; text-align: center; }
    .elvax-generation-queue__thumb img { width: 100%; height: 100%; object-fit: contain; }
    .elvax-generation-queue__label { margin: 0 0 2px; color: var(--descrip-text, #aaa); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
    .elvax-generation-queue__prompt { display: -webkit-box; overflow: hidden; color: var(--fg-color, #ddd); -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow-wrap: anywhere; }
    .elvax-generation-queue__empty, .elvax-generation-queue__error { padding: 14px 4px; color: var(--descrip-text, #aaa); }
    .elvax-generation-queue__error { flex: 0 0 auto; max-height: 42px; overflow: auto; color: #ffaaaa; }
  `;
  document.head.append(style);
}

function createImageThumbnail(image) {
  const container = el("div", "elvax-generation-queue__thumb", "No image");
  if (!image) return container;

  container.textContent = "";
  const thumbnail = document.createElement("img");
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  thumbnail.src = api.apiURL(`/view?${query.toString()}`);
  thumbnail.alt = image.filename;
  thumbnail.onerror = () => {
    container.textContent = "Image unavailable";
  };
  container.append(thumbnail);
  return container;
}

function createItem(item, view, order) {
  const isRunning = item.state === "Running";
  const row = el("article", `elvax-generation-queue__item${isRunning ? " elvax-generation-queue__item--running" : ""}`);
  const header = el("div", "elvax-generation-queue__item-header");
  const dot = el("span", `elvax-generation-queue__state-dot${isRunning ? " elvax-generation-queue__state-dot--running" : ""}`);
  dot.setAttribute("aria-hidden", "true");
  header.append(dot, el("span", "elvax-generation-queue__number", `#${order}`),
    el("span", `elvax-generation-queue__state${isRunning ? " elvax-generation-queue__state--running" : ""}`, item.state));

  const isPaused = item.state === "Paused";
  if (isPaused) {
    const actions = el("div", "elvax-generation-queue__item-actions");
    for (const [direction, label, title] of [[-1, "↑", "Move job up"], [1, "↓", "Move job down"]]) {
      const button = el("button", "elvax-generation-queue__reorder", label);
      actionIcon(button, direction < 0 ? "up" : "down", title);
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", `${title}, #${order}`);
      button.dataset.reorderJob = item.job.key;
      const workflowId = item.job.workflow?.id;
      const queuedCount = workflowQueueItems(workflowId).length;
      button.dataset.atLimit = String(direction < 0 ? order === queuedCount + 1 : order === queuedCount + workflowJobs(workflowId).length);
      button.disabled = queueActionInProgress || button.dataset.atLimit === "true";
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await runQueueAction(view, () => movePausedJob(item.job, direction));
        } catch (error) {
          view.actionError = `Could not reorder job: ${error.message || "request failed"}`;
          view.error.textContent = view.actionError;
          view.error.style.display = "block";
        }
      });
      actions.append(button);
    }
    const resume = el("button", "elvax-generation-queue__pause");
    actionIcon(resume, "play", "Resume job");
    resume.type = "button";
    resume.dataset.pausedJob = item.job.key;
    resume.disabled = queueActionInProgress;
    resume.addEventListener("pointerdown", (event) => event.stopPropagation());
    resume.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runQueueAction(view, () => resumeQueue(view, item.job.key));
    });
    actions.append(resume);
    header.append(actions);
  }
  if (item.state === "Queued") {
    const actions = el("div", "elvax-generation-queue__item-actions");
    const pause = el("button", "elvax-generation-queue__pause");
    actionIcon(pause, "pause", "Pause job");
    pause.type = "button";
    pause.dataset.queuePause = "true";
    pause.disabled = queueActionInProgress;
    pause.addEventListener("pointerdown", (event) => event.stopPropagation());
    pause.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runQueueAction(view, () => pauseQueuedJob(item, view));
    });
    actions.append(pause);
    header.append(actions);
  }
  if (isRunning) {
    const stop = el("button", "elvax-generation-queue__cancel");
    actionIcon(stop, "stop", "Stop job - keep saved to run again");
    stop.type = "button";
    stop.disabled = queueActionInProgress;
    stop.addEventListener("pointerdown", (event) => event.stopPropagation());
    stop.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runQueueAction(view, () => stopRunningJob(item, view));
    });
    header.append(stop);
  }
  const cancel = el("button", "elvax-generation-queue__cancel");
  actionIcon(cancel, "remove", isRunning ? "Cancel job - discard without saving" : "Cancel job");
  cancel.type = "button";
  if (item.state === "Queued") {
    cancel.style.marginLeft = "0";
    cancel.dataset.queueCancel = "true";
    cancel.disabled = queueActionInProgress;
  }
  if (isRunning) {
    cancel.disabled = queueActionInProgress;
    cancel.style.marginLeft = "0";
  }
  if (isPaused) {
    cancel.dataset.pausedJob = item.job.key;
    cancel.disabled = queueActionInProgress;
    cancel.style.marginLeft = "0";
  }
  cancel.addEventListener("pointerdown", (event) => event.stopPropagation());
  cancel.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const confirmed = app.extensionManager?.dialog?.confirm
      ? await app.extensionManager.dialog.confirm({
          title: "Cancel job?",
          message: isRunning ? "Cancel the running job without saving it? This cannot be undone." :
            `Cancel job #${order}? This cannot be undone.`,
        })
      : window.confirm(isRunning ? "Cancel the running job without saving it? This cannot be undone." :
          `Cancel job #${order}? This cannot be undone.`);
    if (!confirmed) return;

    cancel.disabled = true;
    try {
      if (isPaused) {
        await runQueueAction(view, () => removePausedJob(item.job, view));
        return;
      }
      await runQueueAction(view, async () => {
        const response = await api.fetchApi(`/api/jobs/${encodeURIComponent(item.promptId)}/cancel`, {
          method: "POST",
        });
        if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
        await changeQueueState((state) => {
          const jobs = state.jobs.filter((job) => job.promptId !== item.promptId);
          if (jobs.length === state.jobs.length) return state;
          const workflowId = queueWorkflowId(item.extraData?.extra_pnginfo?.workflow);
          return jobs.some((job) => job.workflow?.id === workflowId) ? { ...state, jobs } : resumeWorkflow({ ...state, jobs }, workflowId);
        });
        app.extensionManager?.toast?.add({
          severity: "info",
          summary: "Cancellation requested",
          detail: isRunning ? "The running job will stop without being saved." : `Job #${order} will not run.`,
          life: 2500,
        });
        view.signature = null;
        refreshQueue();
      });
    } catch (error) {
      cancel.disabled = false;
      app.extensionManager?.toast?.add({
        severity: "error",
        summary: "Could not cancel job",
        detail: error.message || "ComfyUI request failed.",
        life: 4000,
      });
    }
  });
  header.append(cancel);

  const body = el("div", "elvax-generation-queue__body");
  const image = findFirstImage(item.prompt, item.extraData);
  const details = document.createElement("div");
  const promptLabel = el("div", "elvax-generation-queue__label", "First prompt");
  const prompt = findFirstPrompt(item.prompt, item.extraData);
  const promptText = el("div", "elvax-generation-queue__prompt", prompt || "Prompt unavailable");
  details.append(promptLabel, promptText);
  body.append(createImageThumbnail(image), details);
  row.append(header, body);
  return row;
}

function renderView(view, items) {
  const signature = JSON.stringify(items.map((item) => [item.promptId, item.state]));
  if (signature === view.signature) return;
  view.signature = signature;
  const scrollTop = view.list.scrollTop;
  const waitingRows = [];
  const runningRows = [];
  const rows = new Map();
  items.forEach((item, index) => {
    const key = `${item.state}:${item.promptId}`;
    const signature = `${index}:${item.state === "Paused" && index === items.findIndex((entry) => entry.state === "Paused")}:${item.state === "Paused" && index === items.length - 1}`;
    const previous = view.rows.get(key);
    const row = previous?.signature === signature ? previous.row : createItem(item, view, index + 1);
    rows.set(key, { signature, row });
    (item.state === "Running" ? runningRows : waitingRows).push(row);
  });
  view.rows = rows;
  if (!items.some((item) => item.state !== "Running")) {
    waitingRows.push(el("div", "elvax-generation-queue__empty", items.length ? "No waiting jobs." : "No queued or running items."));
  }
  for (const [parent, children] of [[view.running, runningRows], [view.list, waitingRows]]) {
    const keep = new Set(children);
    for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
    children.forEach((child, index) => {
      if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
    });
  }
  updateQueueControls(view);
  view.list.scrollTop = scrollTop;
}

async function refreshQueue() {
  if (refreshInProgress || nodeViews.size === 0 || document.hidden) return;
  refreshInProgress = true;
  try {
    await queueDbReady;
    const previous = new Map(serverQueueItems.map((item) => [item.promptId, item]));
    const response = await api.fetchApi("/elvax/generation-queue-manager/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ known_ids: [...previous.keys()] }),
    });
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
    const queue = await response.json();
    serverQueueItems = queue.items.map((item) => item.tuple ? queueItem(item.tuple, item.state) :
      { ...previous.get(item.id), state: item.state });
    for (const view of nodeViews) {
      if (!view.root.isConnected) continue;
      const error = view.actionError || queueStateError?.message;
      view.error.textContent = error || "";
      view.error.style.display = error ? "block" : "none";
    }
    renderQueueViews();
  } catch (error) {
    for (const view of nodeViews) {
      if (!view.root.isConnected) continue;
      view.error.textContent = `Could not load queue: ${error.message || "request failed"}`;
      view.error.style.display = "block";
    }
  } finally {
    refreshInProgress = false;
  }
}

function renderQueueViews() {
  const workflowId = app.graph.id;
  const items = [
    ...workflowQueueItems(workflowId),
    ...workflowJobs(workflowId).map((job) => ({
      promptId: job.promptId || job.key,
      prompt: job.prompt || {},
      extraData: { extra_pnginfo: { workflow: job.workflow } },
      state: "Paused",
      job,
    })),
  ];
  updateAllQueueControls();
  for (const view of nodeViews) {
    if (view.root.isConnected) renderView(view, items);
  }
}

function onQueueWheel(event) {
  if (!(event.target instanceof Element)) return;
  const root = event.target.closest(".elvax-generation-queue") ||
    event.target.closest(".lg-node")?.querySelector(".elvax-generation-queue");
  if (!root) return;
  for (const view of nodeViews) {
    if (view.root !== root) continue;
    event.preventDefault();
    event.stopPropagation();
    if (view.list.scrollHeight <= view.list.clientHeight) {
      app.canvas._mousewheel_callback(event);
      return;
    }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.list.clientHeight : 1;
    view.list.scrollTop += event.deltaY * unit;
    return;
  }
}

function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  addStyles();
  onVisibilityChange();
  api.addEventListener("status", onStatus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("wheel", onQueueWheel, { capture: true, passive: false });
}

function stopPolling() {
  if (nodeViews.size) return;
  clearInterval(pollTimer);
  clearTimeout(refreshTimer);
  pollTimer = null;
  pollingStarted = false;
  serverQueueItems = [];
  api.removeEventListener("status", onStatus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.removeEventListener("wheel", onQueueWheel, true);
}

function onStatus() {
  if (document.hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshQueue, 150);
}

function onVisibilityChange() {
  clearInterval(pollTimer);
  clearTimeout(refreshTimer);
  pollTimer = null;
  if (document.hidden || !nodeViews.size) return;
  refreshQueue();
  pollTimer = setInterval(refreshQueue, POLL_INTERVAL_MS);
}

function installNode(node) {
  if (node.__elvaxGenerationQueueManagerInstalled) return;
  node.__elvaxGenerationQueueManagerInstalled = true;

  const root = document.createElement("div");
  root.className = "elvax-generation-queue";
  root.title = "Controls queued and paused jobs for this workflow.";
  const header = el("div", "elvax-generation-queue__header");
  const heading = el("div", "elvax-generation-queue__heading");
  const counts = [];
  for (const [name, state] of [["In Queue", "queued"], ["Paused", "paused"]]) {
    const stat = el("div", `elvax-generation-queue__stat elvax-generation-queue__stat--${state}`);
    const count = el("span", "elvax-generation-queue__count", "0");
    stat.append(el("span", "", `${name} ·`), count);
    heading.append(stat);
    counts.push(count);
  }
  const [queuedCount, pausedCount] = counts;
  const controls = el("div", "elvax-generation-queue__controls");
  const pauseButton = el("button", "elvax-generation-queue__pause", "Pause Queue");
  pauseButton.type = "button";
  pauseButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  pauseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    runQueueAction(view, () => pauseQueue(view));
  });
  actionIcon(pauseButton, "pause", "Pause queued jobs and new submissions for this workflow");
  const resumeButton = el("button", "elvax-generation-queue__pause");
  actionIcon(resumeButton, "play", "Resume all paused jobs in this workflow");
  const removeAllButton = el("button", "elvax-generation-queue__pause");
  actionIcon(removeAllButton, "remove", "Cancel all queued and paused jobs in this workflow");
  for (const [button, action] of [[resumeButton, resumeQueue], [removeAllButton, removeAllJobs]]) {
    button.type = "button";
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runQueueAction(view, () => action(view));
    });
  }
  const toolbar = el("div", "elvax-generation-queue__toolbar");
  toolbar.append(pauseButton, resumeButton, removeAllButton);
  controls.append(heading, toolbar);
  const running = el("div", "elvax-generation-queue__running");
  header.append(running, controls);
  const list = document.createElement("div");
  list.className = "elvax-generation-queue__list";
  const error = el("div", "elvax-generation-queue__error", "");
  error.style.display = "none";
  root.append(header, list, error);

  const widget = node.addDOMWidget("generation_queue_manager", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_WIDGET_HEIGHT,
  });
  widget.computeLayoutSize = () => ({
    minHeight: MIN_WIDGET_HEIGHT,
    minWidth: 1,
  });
  const naturalSize = node.computeSize();
  const nodeChromeHeight = Math.max(0, naturalSize[1] - MIN_WIDGET_HEIGHT);
  const minimumHeight = MIN_WIDGET_HEIGHT + nodeChromeHeight;
  node.min_size = [MIN_NODE_WIDTH, minimumHeight];
  const originalComputeSize = node.computeSize;
  node.computeSize = function (...args) {
    const size = originalComputeSize.apply(this, args);
    size[0] = Math.max(size[0], MIN_NODE_WIDTH);
    size[1] = Math.max(size[1], minimumHeight);
    return size;
  };
  const originalResize = node.onResize;
  node.onResize = function (size) {
    size[0] = Math.max(size[0], MIN_NODE_WIDTH);
    size[1] = Math.max(size[1], minimumHeight);
    return originalResize?.apply(this, arguments);
  };
  requestAnimationFrame(() => {
    if (node.size[0] < MIN_NODE_WIDTH || node.size[1] < minimumHeight) {
      node.setSize([Math.max(node.size[0], MIN_NODE_WIDTH), Math.max(node.size[1], minimumHeight)]);
    }
  });

  const view = { root, header, running, list, queuedCount, pausedCount, error, pauseButton, resumeButton, removeAllButton, signature: null, rows: new Map() };
  nodeViews.add(view);
  if (queueStateError) {
    error.textContent = queueStateError.message;
    error.style.display = "block";
  }
  renderQueueViews();
  startPolling();

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    nodeViews.delete(view);
    stopPolling();
    return originalRemoved?.apply(this, args);
  };
}

app.registerExtension({
  name: "elvax.generation-queue-manager",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      installNode(this);
      return result;
    };
  },
});
