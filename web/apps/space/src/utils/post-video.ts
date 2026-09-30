import type { FFmpegCommand } from "ente-base/types/ipc";
import type { PreparedSpacePostImage } from "utils/post-image";
import { thumbHashBase64FromCanvas } from "utils/thumbhash";
import {
    inputPathPlaceholder,
    outputPathPlaceholder,
} from "./video-encoding/constants";

export interface SpacePostVideoEdit {
    start: number;
    end: number;
    coverTime: number;
    muted: boolean;
}

export interface SpaceVideoInfo {
    duration: number;
    width: number;
    height: number;
}

export const maxSpaceVideoDuration = 10;

export const isSpaceVideoFile = (file: File) =>
    file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name);

export const initialSpaceVideoEdit = (
    duration: number,
): SpacePostVideoEdit => ({
    start: 0,
    end: Math.min(duration, maxSpaceVideoDuration),
    coverTime: 0,
    muted: false,
});

export const clampVideoCover = (edit: SpacePostVideoEdit) => ({
    ...edit,
    coverTime: Math.max(edit.start, Math.min(edit.coverTime, edit.end - 0.001)),
});

const waitForVideo = (
    video: HTMLVideoElement,
    event: "loadeddata" | "seeked",
    signal?: AbortSignal,
) =>
    new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
            window.clearTimeout(timer);
            video.removeEventListener(event, ready);
            video.removeEventListener("error", failed);
            signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve();
        };
        const ready = () => finish();
        const failed = () =>
            finish(new Error("This browser can't preview this video."));
        const abort = () => finish(new DOMException("Canceled", "AbortError"));
        const timer = window.setTimeout(
            () => finish(new Error("The video took too long to load.")),
            30_000,
        );
        video.addEventListener(event, ready, { once: true });
        video.addEventListener("error", failed, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });

export const openSpaceVideo = async (file: Blob, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const dispose = () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
    };
    try {
        const ready = waitForVideo(video, "loadeddata", signal);
        video.src = url;
        video.load();
        await ready;
        return { video, dispose };
    } catch (error) {
        dispose();
        throw error;
    }
};

export const seekSpaceVideo = async (
    video: HTMLVideoElement,
    time: number,
    signal?: AbortSignal,
) => {
    signal?.throwIfAborted();
    const target = Math.max(0, Math.min(time, video.duration - 0.001));
    if (video.currentTime == target) return;
    const ready = waitForVideo(video, "seeked", signal);
    video.currentTime = target;
    await ready;
};

export const spaceVideoInfo = async (file: File): Promise<SpaceVideoInfo> => {
    const { video, dispose } = await openSpaceVideo(file);
    try {
        if (!Number.isFinite(video.duration) || video.duration <= 0)
            throw new Error("This video has no readable duration.");
        return {
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
        };
    } finally {
        dispose();
    }
};

export const spaceVideoCover = async (
    file: Blob,
    time: number,
    signal?: AbortSignal,
): Promise<PreparedSpacePostImage> => {
    const { video, dispose } = await openSpaceVideo(file, signal);
    try {
        await seekSpaceVideo(video, time, signal);
        const scale = Math.min(
            1,
            1280 / Math.max(video.videoWidth, video.videoHeight),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Couldn't prepare the video cover.");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const thumbHash = thumbHashBase64FromCanvas(canvas);
        const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
                (blob) =>
                    blob
                        ? resolve(blob)
                        : reject(
                              new Error("Couldn't prepare the video cover."),
                          ),
                "image/webp",
                0.85,
            ),
        );
        return {
            file: new File([blob], "cover.webp", { type: blob.type }),
            width: canvas.width,
            height: canvas.height,
            thumbHash,
        };
    } finally {
        dispose();
    }
};

const videoExportCommand = (
    edit: SpacePostVideoEdit,
    hdr: boolean,
): string[] => [
    "-ss",
    String(edit.start),
    "-i",
    inputPathPlaceholder,
    "-t",
    String(Math.min(maxSpaceVideoDuration, edit.end - edit.start)),
    "-map",
    "0:v:0",
    ...(edit.muted
        ? ["-an"]
        : ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k"]),
    "-map_metadata",
    "-1",
    "-map_metadata:s",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    [
        "fps=30:start_time=0",
        "scale=w='trunc(iw*min(1,min(1920/max(iw,ih),1080/min(iw,ih)))/2)*2':h='trunc(ih*min(1,min(1920/max(iw,ih),1080/min(iw,ih)))/2)*2'",
        ...(hdr
            ? [
                  "zscale=transfer=linear",
                  "tonemap=tonemap=hable:desat=0",
                  "zscale=primaries=709:transfer=709:matrix=709",
              ]
            : []),
        "format=yuv420p",
        "setsar=1",
    ].join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-maxrate",
    "8M",
    "-bufsize",
    "16M",
    "-movflags",
    "+faststart",
    outputPathPlaceholder,
];

const exports = new WeakMap<
    File,
    { key: string; file: File; durationMs: number }
>();

export const prepareSpaceVideo = async (
    file: File,
    edit: SpacePostVideoEdit,
    signal?: AbortSignal,
) => {
    signal?.throwIfAborted();
    const duration = edit.end - edit.start;
    if (
        ![edit.start, edit.end, edit.coverTime].every(Number.isFinite) ||
        edit.start < 0 ||
        duration <= 0 ||
        duration > maxSpaceVideoDuration + 0.000001
    )
        throw new Error("Choose a video segment of up to 10 seconds.");
    const key = JSON.stringify([edit.start, edit.end, edit.muted]);
    let exported = exports.get(file);
    if (exported?.key != key) {
        const { transcodeVideoWeb, determineVideoDurationWeb } =
            await import("./video-encoding/web");
        const command: FFmpegCommand = {
            default: videoExportCommand(edit, false),
            hdr: videoExportCommand(edit, true),
        };
        const bytes = await transcodeVideoWeb(file, edit, command, signal);
        signal?.throwIfAborted();
        const output = new File([bytes], "video.mp4", { type: "video/mp4" });
        if (output.size > 15 * 1024 * 1024 - 42)
            throw new Error("This video is too large. Try a shorter trim.");
        const outputDuration = await determineVideoDurationWeb(output, signal);
        if (
            !Number.isFinite(outputDuration) ||
            outputDuration <= 0 ||
            outputDuration > 10.000001
        )
            throw new Error("Couldn't export a video within 10 seconds.");
        exported = {
            key,
            file: output,
            durationMs: Math.min(10_000, Math.ceil(outputDuration * 1000)),
        };
        exports.set(file, exported);
    }
    signal?.throwIfAborted();
    const cover = await spaceVideoCover(
        exported.file,
        Math.max(0, edit.coverTime - edit.start),
        signal,
    );
    return {
        ...cover,
        video: { file: exported.file, durationMs: exported.durationMs },
    };
};
