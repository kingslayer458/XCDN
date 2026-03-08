const uploadForm = document.getElementById("uploadForm");
const videoFileInput = document.getElementById("videoFile");
const statusEl = document.getElementById("status");
const videoListEl = document.getElementById("videoList");
const player = document.getElementById("player");
const streamUrlInput = document.getElementById("streamUrl");
const videoTagSnippet = document.getElementById("videoTagSnippet");
const copyUrlBtn = document.getElementById("copyUrlBtn");
const copyTagBtn = document.getElementById("copyTagBtn");
const uploadProgress = document.getElementById("uploadProgress");
const searchInput = document.getElementById("searchInput");
const refreshBtn = document.getElementById("refreshBtn");
let selectedVideo = null;
let currentVideos = [];

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const selected = videoFileInput.files?.[0];
  if (!selected) {
    statusEl.textContent = "Select a video first.";
    return;
  }

  const data = new FormData();
  data.append("video", selected);

  setStatus("Uploading...");
  uploadProgress.hidden = false;
  uploadProgress.value = 0;

  try {
    const result = await uploadWithProgress(data, (percent) => {
      uploadProgress.value = percent;
    });

    setStatus(`Uploaded: ${result.video.originalName}`);
    uploadForm.reset();
    await loadVideos();
  } catch (error) {
    setStatus(error.message || "Upload failed");
  } finally {
    uploadProgress.hidden = true;
    uploadProgress.value = 0;
  }
});

searchInput.addEventListener("input", () => {
  renderVideos();
});

refreshBtn.addEventListener("click", async () => {
  setStatus("Refreshing list...");
  await loadVideos();
  setStatus("Video list refreshed.");
});

copyUrlBtn.addEventListener("click", async () => {
  if (!selectedVideo?.streamUrlAbsolute) {
    setStatus("Select a video first.");
    return;
  }
  await copyText(selectedVideo.streamUrlAbsolute, "CDN URL copied.");
});

copyTagBtn.addEventListener("click", async () => {
  if (!selectedVideo?.videoTag) {
    setStatus("Select a video first.");
    return;
  }
  await copyText(selectedVideo.videoTag, "Video tag copied.");
});

async function loadVideos() {
  const response = await fetch("/api/videos");
  const result = await response.json();
  currentVideos = result.videos || [];
  renderVideos();

  if (!selectedVideo && currentVideos[0]) {
    selectVideo(currentVideos[0], false);
  }
}

function renderVideos() {
  videoListEl.innerHTML = "";
  const query = (searchInput.value || "").trim().toLowerCase();
  const videos = !query
    ? currentVideos
    : currentVideos.filter((video) => (video.originalName || "").toLowerCase().includes(query));

  if (!videos || videos.length === 0) {
    const li = document.createElement("li");
    li.textContent = query ? "No match for this search." : "No videos uploaded yet.";
    videoListEl.appendChild(li);
    return;
  }

  for (const video of videos) {
    const li = document.createElement("li");
    li.className = "videoRow";

    if (selectedVideo?.id === video.id) {
      li.classList.add("is-selected");
    }

    const playButton = document.createElement("button");
    playButton.textContent = "Play";
    playButton.className = "btnSecondary";
    playButton.addEventListener("click", () => {
      selectVideo(video, true);
    });

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.className = "btnDanger";
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteVideo(video);
    });

    const name = document.createElement("span");
    name.textContent = `${video.originalName} (${formatSize(video.size)})`;

    li.addEventListener("click", () => {
      selectVideo(video, false);
    });

    li.appendChild(playButton);
    li.appendChild(name);
    li.appendChild(deleteButton);
    videoListEl.appendChild(li);
  }
}

async function deleteVideo(video) {
  const yes = confirm(`Delete this video?\n\n${video.originalName}`);
  if (!yes) {
    return;
  }

  setStatus(`Deleting: ${video.originalName}`);
  try {
    const response = await fetch(`/api/videos/${encodeURIComponent(video.id)}`, {
      method: "DELETE",
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Delete failed");
    }

    if (selectedVideo?.id === video.id) {
      selectedVideo = null;
      player.removeAttribute("src");
      player.load();
      streamUrlInput.value = "";
      videoTagSnippet.value = "";
    }

    setStatus(`Deleted: ${video.originalName}`);
    await loadVideos();
  } catch (error) {
    setStatus(error.message || "Delete failed");
  }
}

function selectVideo(video, autoPlay) {
  selectedVideo = video;
  player.src = video.streamUrlAbsolute || video.streamUrl;
  streamUrlInput.value = video.streamUrlAbsolute || "";
  videoTagSnippet.value =
    video.videoTag ||
    `<video controls preload="metadata" src="${video.streamUrlAbsolute || video.streamUrl}"></video>`;
  renderVideos();

  if (autoPlay) {
    player.play().catch(() => {});
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    setStatus(successMessage);
  } catch {
    setStatus("Clipboard blocked. Copy manually from the field.");
  }
}

function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    };

    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onload = () => {
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        payload = {};
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      reject(new Error(payload.error || "Upload failed"));
    };

    xhr.send(formData);
  });
}

loadVideos().catch(() => {
  setStatus("Could not load video list.");
});
