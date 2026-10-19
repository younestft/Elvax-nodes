# Turbo Post Processing changes

Date: 2026-10-16

## Workspace

The supplied checkout path no longer existed. The changes were made in the checkout at:

`E:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\Elvax-nodes`

## 1. Upscaling before interpolation

Previously, Turbo interpolated frames with RIFE and then upscaled the resulting frames.

The processing order is now:

1. Upscale the source frames using native Lanczos.
2. Interpolate the upscaled frames with RIFE.
3. Apply film grain when enabled.
4. Encode the video.

This reduces the number of frames requiring upscaling. RIFE now works at the upscaled resolution, so its runtime and memory requirements can increase. This order was explicitly requested and accepted.

Progress counting was updated to follow the new order.

## 2. Parallel native Lanczos

Inspected ComfyUI's `ImageScaleBy` class in `nodes.py` and its Lanczos implementation in `comfy/utils.py`.

Turbo already called the native Upscale Image By node. Its Lanczos path resizes frames sequentially on the CPU through Pillow.

Added `_upscale_group` in `post_processing.py` to run those same native calls concurrently:

- Up to six frames can be resized at once.
- Worker count is capped by the reported CPU count and selected group size.
- A worker pool is created once per Turbo execution and reused between groups.
- Work is submitted through a bounded queue. Each completed frame frees a slot for another frame, so workers do not wait for an entire window to finish.
- Results are copied into their original frame positions.
- Upscaling stays on the CPU and still uses native Lanczos.
- Workers are shut down on completion or failure; pending work is cancelled during cleanup.
- Interruption checks run between windows.

No bicubic option or new dependencies were added. Node IDs, inputs, outputs, and workflow settings remain unchanged.

## 3. Reuse the upscaled boundary frame

Turbo's groups overlap by one source frame so RIFE can interpolate smoothly across group boundaries. Previously, the overlapping frame was upscaled again in the next group.

The last upscaled frame is now copied into a temporary execution-local cache and reused as the first frame of the next group.

- Each source frame is upscaled once per execution.
- The cache holds one copied frame, rather than a view retaining the previous group's full tensor.
- The cache is cleared during cleanup and does not persist between executions.
- The duplicate output frame is still removed after interpolation to preserve frame count and order.
- This saves proportionally more resizing work with small custom batches.

Progress now advances once for each newly upscaled source frame.

## Files changed

| File | Changes |
| --- | --- |
| `post_processing.py` | Processing order, parallel Lanczos, boundary reuse, progress accounting, worker/cache cleanup. |
| `tests/test_post_processing.py` | Expanded batching tests and added pixel equality, concurrency, cache storage, and worker failure checks. |
| `web/post_processing.js` | Remove the leftover socket for the hidden upscale-method control. |
| `docs/TURBO_POST_PROCESSING_CHANGES.md` | This report. |

Existing edits were preserved: `dual_pass_rife` was already changed to default to false in `post_processing.py`, and `web/post_processing.js` already contained a widget/input change. Those edits were not introduced by this work.

## Verification

All thirteen post-processing tests passed in the configured ComfyUI Python environment. Python compilation and `git diff --check` also passed.

Checks covered:

- Exact pixel equality with native Lanczos on random image data.
- Concurrent execution of resizing calls.
- Reuse of the boundary frame with no repeated source-frame upscaling.
- Every batching mode, with upscaling both enabled and disabled, including custom batch size 1.
- Output dimensions, frame count, frame order, FPS, and progress completion.
- Preservation of input tensors.
- Grain behavior, audio handling, encoding, and error cleanup.
- Worker and encoder shutdown after a simulated upscaling failure.
- Continuous worker refill while another frame is still resizing.
- Preparing only one next group while the current group is processed.
- Propagation of a failed prefetched group and shutdown of its workers.

Unit interpolation tests use a lightweight linear RIFE substitute. Separate performance and pixel-comparison checks use the installed RIFE 4.9 model on the RTX 3090. A live ComfyUI UI run was not performed.

## Local scaling benchmarks

CPU: Intel Core i5-14600K, 14 cores / 20 logical processors.

Measured native Lanczos scaling plus output assembly on random CPU images at 2x scale. Each timing is the median of two runs. The original comparison used one sequential native call for the input batch followed by copying its output. Parallel measurements included worker-pool creation and shutdown.

| Input batch | Original sequential | 1 worker | 2 workers | 4 workers | Four-worker speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| 12 frames, 640 x 360 to 1280 x 720 | 0.264 s | 0.316 s | 0.189 s | 0.147 s | 1.80x |
| 6 frames, 1280 x 720 to 2560 x 1440 | 0.521 s | 0.599 s | 0.400 s | 0.331 s | 1.57x |

Four workers were the fastest configuration in that original comparison, which tested one, two, and four workers. The later comparison also tested six and eight workers. These original scaling benchmarks do not include RIFE or encoding, and do not measure boundary reuse.

Process RAM was sampled during benchmarking, but the configurations ran in one process with retained reference images and allocator reuse. Those measurements do not isolate each implementation's memory cost. The original four-worker comparison used at most four concurrent resize jobs, plus the group output and one cached boundary frame.

## 4. Prepare the next group during interpolation

When upscaling and interpolation are both enabled and the sequence spans multiple groups, a single preparation worker upscales the next group while RIFE and grain process the current one. It uses the same bounded resize pool and boundary cache. There is at most one prepared group ahead of the consumer. Full-sequence mode has no next group to prepare.

This can retain one additional upscaled group in system RAM. It does not add GPU inference batches. The current upscaled group is released after interpolation, before grain processing. Progress updates remain on the execution thread; resize and preparation workers are shut down on completion, interruption, or error.

### Current implementation benchmark

Tested four, six, and eight workers, continuous scheduling, and preparing one group ahead. Six workers with preparation ahead was selected from the real-RIFE pipeline comparisons; eight workers was faster for isolated resizing but did not improve the whole pipeline in the larger test.

The following comparison alternated the original four-worker implementation with the selected implementation. It used 70 synthetic random RGB frames at 960 x 640, 2x Lanczos, the installed RIFE 4.9 at 2x interpolation with dual pass off, grain enabled, and video encoding. Outputs contained 139 frames at 1920 x 1280 and 48 FPS. Timings are medians of three runs on the i5-14600K and RTX 3090. RIFE weights were loaded and inference warmed before timing both implementations.

| Mode | Original four-worker windows | Six workers and one group ahead | Total time reduction |
| --- | ---: | ---: | ---: |
| normal (64) | 8.07 s | 7.72 s | 4.3% |
| low vram (16) | 6.97 s | 5.90 s | 15.4% |

Peak allocated CUDA memory was effectively unchanged at about 1,308 MiB in this test. These results are workload-specific and exclude model-loading time. Preparing ahead uses additional system RAM; it is not a RAM reduction. The earlier exploratory trial retained the upscaled source longer than necessary; this was corrected before the alternating comparison.

A longer normal-mode comparison used 130 input frames with the same dimensions and settings, filling two 64-frame groups and producing 259 output frames. Alternating two runs of each implementation gave median times of **14.40 s before and 12.41 s after**, a **13.8% total time reduction**. Peak allocated CUDA memory was again unchanged at about 1,308 MiB. Upscaling time averaged 4.02 s before and 3.11 s after; the remaining improvement came from overlapping preparation with subsequent work.

Decoded-pixel comparison used 20 source frames, two 16-frame groups, real RIFE, and all 39 output frames, with grain both disabled and enabled. With fixed seeds and deterministic cuDNN settings in the test process, old and new decoded RGB pixels matched exactly. Under ordinary backend settings, repeated old-code runs also showed GPU numerical variation; deterministic settings were used only to isolate correctness and were not added to the node or used for the performance comparisons.

## 5. Keep interpolated frames on the GPU through grain

RIFE now emits ordered four-frame batches into a reusable execution-local buffer on its device. Original frames and interpolated frames retain their previous order and dtype, with overlapping boundary frames omitted before grain. The full interpolated float group is no longer built in system RAM.

Grain consumes these device batches directly. Each finished batch moves to the CPU as owned 8-bit pixels and is immediately submitted to the encoder. With grain disabled, conversion to 8-bit still happens before moving generated frames to the CPU. Non-interpolated paths also submit small owned batches. The encoder queue stays bounded to one four-frame batch, in addition to the batches currently being processed and encoded.

This removes the GPU-to-CPU float download and subsequent CPU-to-GPU grain upload for generated frames. CPU upscaling and its one-group-ahead preparation are retained. The input sequence and upscaled source groups can still occupy system RAM.

CUDA events measure the asynchronous RIFE work without adding a synchronization between RIFE and grain. Finished CPU pixel copies provide the synchronization before event timings are read. Stage statistics retain their existing labels, while total benchmark comparisons use wall time.

### Streaming comparison against section 4

Alternating three runs of each implementation used the same 70-frame, 960 x 640 source, 2x upscale, 2x RIFE 4.9, dual pass off, grain on, and encoding setup described above. Both implementations used the selected six-worker upscaler and one-group-ahead preparation. RIFE weights were loaded and inference warmed before timing.

| Mode | Before streaming | After streaming | Total time reduction |
| --- | ---: | ---: | ---: |
| normal (64) | 7.18 s | 4.64 s | 35.3% |
| low vram (16) | 5.37 s | 4.03 s | 25.1% |

Peak allocated CUDA memory increased from approximately 1,308 MiB to 1,421 MiB for these dimensions, due to the four-frame device buffer. This is a speed and system-RAM optimization, not a VRAM reduction. Test-process deterministic cuDNN settings and fixed seeds again produced pixel-identical decoded results against the section 4 implementation, with grain both on and off.

Separate memory checks ran each version and mode in a fresh process with the same 70-frame dimensions and settings. Process working set was sampled every 10 ms. Each process started the timed operation at approximately 1,733 MiB, after loading/warming RIFE and allocating the input. These are single-run observed process peaks, including libraries, input, and allocator retention, rather than isolated tensor sizes.

| Mode | Previous peak process RAM | Streaming peak process RAM |
| --- | ---: | ---: |
| normal (64) | 10,237 MiB | 6,478 MiB |
| low vram (16) | 8,466 MiB | 6,595 MiB |

The extra device-buffer VRAM scales with frame dimensions; the approximately 113 MiB increase above applies only to the tested 1920 x 1280 output.

The additional unit test checks that the encoder receives owned CPU 8-bit batches of at most four frames before interpolation of the group finishes. Frame-count, order, progress, input preservation, audio, error, and worker-cleanup checks continue to pass.

## Applying the changes

Restart ComfyUI to load the updated Python implementation. Existing Turbo workflows use the optimizations automatically when upscaling is enabled.
