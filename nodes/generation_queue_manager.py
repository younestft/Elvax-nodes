from aiohttp import web
from server import PromptServer


def _is_workflow_job(item, workflow_id):
    workflow = item[3].get("extra_pnginfo", {}).get("workflow") or {}
    return workflow.get("id") == workflow_id and any(
        node.get("type") == "ElvaxGenerationQueueManager" for node in workflow.get("nodes", [])
    )


@PromptServer.instance.routes.post("/elvax/generation-queue-manager/queue")
async def queue_snapshot(request):
    data = await request.json()
    known_ids = data.get("known_ids") if isinstance(data, dict) else None
    if not isinstance(known_ids, list) or any(not isinstance(value, str) for value in known_ids):
        return web.json_response({"error": "Expected a list of prompt IDs."}, status=400)
    known_ids = set(known_ids)
    queue = PromptServer.instance.prompt_queue
    with queue.mutex:
        running, pending = queue.get_current_queue_volatile()
        items = [{"id": item[1], "state": state, **({"tuple": item[:5]} if item[1] not in known_ids else {})}
                 for state, entries in (("Running", running), ("Queued", sorted(pending, key=lambda item: item[0])))
                 for item in entries]
    return web.json_response({"items": items})


@PromptServer.instance.routes.post("/elvax/generation-queue-manager/cancel-pending")
async def cancel_pending_jobs(request):
    data = await request.json()
    workflow_id = data.get("workflow_id") if isinstance(data, dict) else None
    if not isinstance(workflow_id, str) or not workflow_id:
        return web.json_response({"error": "Expected a workflow ID."}, status=400)
    queue = PromptServer.instance.prompt_queue
    with queue.mutex:
        _, pending = queue.get_current_queue_volatile()
        for item in list(pending):
            if _is_workflow_job(item, workflow_id):
                queue.delete_queue_item(lambda candidate: candidate[1] == item[1])
    return web.json_response({"cancelled": True})


@PromptServer.instance.routes.post("/elvax/generation-queue-manager/pause")
async def pause_pending_jobs(request):
    data = await request.json()
    workflow_id = data.get("workflow_id") if isinstance(data, dict) else None
    if not isinstance(workflow_id, str) or not workflow_id:
        return web.json_response({"error": "Expected a workflow ID."}, status=400)
    prompt_ids = data.get("prompt_ids") if isinstance(data, dict) else None
    if not isinstance(prompt_ids, list) or any(not isinstance(value, str) for value in prompt_ids):
        return web.json_response({"error": "Expected a list of prompt IDs."}, status=400)
    queue = PromptServer.instance.prompt_queue
    paused = []
    with queue.mutex:
        running, pending = queue.get_current_queue_volatile()
        running_ids = {item[1] for item in running}
        pending_ids = {item[1] for item in pending}
        for prompt_id in dict.fromkeys(prompt_ids):
            removed = queue.delete_queue_item(lambda item: item[1] == prompt_id and _is_workflow_job(item, workflow_id))
            if removed or (prompt_id not in pending_ids and prompt_id not in running_ids and not queue.get_history(prompt_id=prompt_id)):
                paused.append(prompt_id)
    return web.json_response({"paused": paused})


@PromptServer.instance.routes.post("/elvax/generation-queue-manager/submitted")
async def saved_job_submitted(request):
    data = await request.json()
    job_key = data.get("job_key") if isinstance(data, dict) else None
    if not isinstance(job_key, str) or not job_key:
        return web.json_response({"error": "Expected a saved job key."}, status=400)
    queue = PromptServer.instance.prompt_queue
    with queue.mutex:
        running, pending = queue.get_current_queue_volatile()
        prompts = [*running, *pending, *(item["prompt"] for item in queue.get_history().values())]
        submitted = False
        for item in prompts:
            workflow = item[3].get("extra_pnginfo", {}).get("workflow") or {}
            if (workflow.get("extra") or {}).get("elvaxQueueJobKey") == job_key:
                submitted = True
                break
    return web.json_response({"submitted": submitted})


class GenerationQueueManager:
    SEARCH_ALIASES = ["elvax"]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "refresh"
    OUTPUT_NODE = True
    CATEGORY = "Elvax Nodes/Utilities"
    DESCRIPTION = "Manage ComfyUI's generation queue. Reorder, pause, resume, or cancel jobs. Stop a running job and keep it saved to run again. Paused jobs remain saved across restarts."

    def refresh(self):
        return ()
