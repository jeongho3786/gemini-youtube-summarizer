const browserAPI = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_MODEL = "gemini-3.6-flash";
const YT_URL_PATTERN = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/i;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const RETRYABLE_STATUS_CODES = [429, 503];
const RETRYABLE_ERROR_STATUSES = ["UNAVAILABLE", "RESOURCE_EXHAUSTED"];
const LOG_PREFIX = "[유튜브요약]";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SUMMARY_PROMPT = `이 유튜브 영상 내용을 분석해서 아래 형식에 맞춰 한국어로 요약해줘. 다른 설명 없이 이 형식만 출력해줘.

형식:
영상 '(영상 제목)'의 핵심 내용은 다음과 같습니다.

1. (핵심 주제 1 제목)
- **(소제목1):** (설명) [MM:SS]
- **(소제목2):** (설명) [MM:SS]

2. (핵심 주제 2 제목)
- **(소제목1):** (설명) [MM:SS]
- **(소제목2):** (설명) [MM:SS]

(마지막 번호 항목은 "결론 및 인사이트"로 작성)

규칙:
- 번호 항목은 4~6개로 구성하고, 마지막 항목은 반드시 "결론 및 인사이트".
- 각 소제목 항목 끝에는 실제로 그 내용이 나오는 영상 재생 시점을 [MM:SS] 또는 [H:MM:SS] 형식으로 반드시 붙여줘.
- 소제목은 **굵게** 표시하고 콜론(:)으로 설명과 구분해줘.`;

let lastSummaryText = "";

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const VIDEO_ID_PATTERN = /^[\w-]{6,20}$/;

// 추출한 값이 유튜브 영상 ID 형식(영문자/숫자/-/_)을 벗어나면 null을 반환해
// href에 안전하지 않은 문자열이 그대로 삽입되는 것을 막는다.
function extractVideoId(url) {
  try {
    const u = new URL(url);
    let candidate = null;

    if (u.hostname.includes("youtu.be")) {
      candidate = u.pathname.slice(1);
    } else {
      const v = u.searchParams.get("v");
      if (v) {
        candidate = v;
      } else {
        const shortsMatch = u.pathname.match(/\/shorts\/([\w-]+)/);
        if (shortsMatch) candidate = shortsMatch[1];
      }
    }

    if (candidate && VIDEO_ID_PATTERN.test(candidate)) return candidate;
  } catch (e) {
    // 잘못된 URL이면 무시
  }
  return null;
}

function timestampToSeconds(ts) {
  const parts = ts.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;

  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// **굵게** 와 [MM:SS] 타임스탬프(클릭 시 해당 시점으로 이동)를 안전하게 HTML로 변환한다.
// 입력은 항상 escapeHtml을 거친 문자열이어야 한다.
function linkifyInline(escapedLine, videoId) {
  let html = escapedLine.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  html = html.replace(/\[(\d{1,2}(?::\d{2}){1,2})\]/g, (match, ts) => {
    if (!videoId) return match;

    const seconds = timestampToSeconds(ts);
    if (seconds == null) return match;

    return `<a href="https://www.youtube.com/watch?v=${videoId}&t=${seconds}s" target="_blank" rel="noopener">${match}</a>`;
  });

  return html;
}

function parseSummaryBlocks(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks = [];
  let current = null;

  for (const line of lines) {
    const topMatch = line.match(/^\d+[.)]\s+(.*)$/);
    const subMatch = line.match(/^[-*]\s+(.*)$/);

    if (topMatch) {
      current = { type: "item", title: topMatch[1], subs: [] };
      blocks.push(current);
    } else if (subMatch && current) {
      current.subs.push(subMatch[1]);
    } else {
      current = null;
      blocks.push({ type: "p", text: line });
    }
  }

  return blocks;
}

function renderSummaryHtml(text, videoUrl) {
  const videoId = extractVideoId(videoUrl);
  const blocks = parseSummaryBlocks(text);

  let html = "";
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "p") {
      html += `<p>${linkifyInline(escapeHtml(block.text), videoId)}</p>`;
      i++;
      continue;
    }

    html += "<ol>";

    while (i < blocks.length && blocks[i].type === "item") {
      const item = blocks[i];
      html += `<li>${linkifyInline(escapeHtml(item.title), videoId)}`;

      if (item.subs.length) {
        html += "<ul>" + item.subs.map((s) => `<li>${linkifyInline(escapeHtml(s), videoId)}</li>`).join("") + "</ul>";
      }

      html += "</li>";
      i++;
    }

    html += "</ol>";
  }

  return html;
}

const els = {
  settingsToggle: document.getElementById("settings-toggle"),
  settingsPanel: document.getElementById("settings-panel"),
  apiKeyInput: document.getElementById("api-key"),
  modelInput: document.getElementById("model"),
  saveSettingsBtn: document.getElementById("save-settings-btn"),
  videoUrlInput: document.getElementById("video-url"),
  summarizeBtn: document.getElementById("summarize-btn"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  resultText: document.getElementById("result-text"),
  copyBtn: document.getElementById("copy-btn"),
};

init();

async function init() {
  const { geminiApiKey, geminiModel, lastSummaryText: storedSummary, lastSummaryVideoUrl } = await browserAPI.storage.local.get([
    "geminiApiKey",
    "geminiModel",
    "lastSummaryText",
    "lastSummaryVideoUrl",
  ]);

  if (geminiApiKey) {
    els.apiKeyInput.value = geminiApiKey;
  } else {
    els.settingsPanel.classList.remove("hidden");
  }

  els.modelInput.value = geminiModel || DEFAULT_MODEL;

  if (storedSummary) {
    lastSummaryText = storedSummary;
    els.resultText.innerHTML = renderSummaryHtml(storedSummary, lastSummaryVideoUrl || "");
    els.result.classList.remove("hidden");

    if (lastSummaryVideoUrl && !extractVideoId(lastSummaryVideoUrl)) {
      showStatus("이전 요약을 불러왔지만, 영상 주소 형식이 예상과 달라 타임스탬프 링크는 표시되지 않습니다.", false);
    }

    log("이전에 저장된 요약 결과를 복원", { textLength: storedSummary.length });
  }

  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    applyTabUrl(tab);
  } catch (e) {
    // 탭 정보를 가져오지 못해도 URL 직접 입력은 계속 가능
  }

  watchActiveTab();
}

// 사이드바는 계속 열려 있으므로, 탭을 전환하거나 다른 유튜브 영상으로 이동할 때마다 주소를 자동 갱신한다.
function watchActiveTab() {
  browserAPI.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await browserAPI.tabs.get(tabId);
      applyTabUrl(tab);
    } catch (e) {
      // 무시: 접근 권한이 없는 탭일 수 있음
    }
  });

  browserAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      applyTabUrl(tab);
    }
  });
}

function applyTabUrl(tab) {
  if (!tab || !tab.url || !YT_URL_PATTERN.test(tab.url)) return;
  if (document.activeElement === els.videoUrlInput) return; // 사용자가 직접 입력 중이면 덮어쓰지 않음
  if (els.videoUrlInput.value === tab.url) return;

  els.videoUrlInput.value = tab.url;

  log("현재 탭의 유튜브 주소로 갱신", tab.url);
}

els.settingsToggle.addEventListener("click", () => {
  els.settingsPanel.classList.toggle("hidden");
});

els.saveSettingsBtn.addEventListener("click", async () => {
  const geminiApiKey = els.apiKeyInput.value.trim();
  const geminiModel = els.modelInput.value.trim() || DEFAULT_MODEL;

  if (!geminiApiKey) {
    showStatus("API 키를 입력해주세요.", true);
    return;
  }

  await browserAPI.storage.local.set({ geminiApiKey, geminiModel });
  showStatus("설정이 저장되었습니다.", false);
  els.settingsPanel.classList.add("hidden");
});

els.summarizeBtn.addEventListener("click", summarize);

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastSummaryText);
    showStatus("클립보드에 복사되었습니다.", false);
  } catch (e) {
    showStatus("복사에 실패했습니다.", true);
  }
});

async function summarize() {
  const videoUrl = els.videoUrlInput.value.trim();
  const { geminiApiKey, geminiModel } = await browserAPI.storage.local.get(["geminiApiKey", "geminiModel"]);

  if (!geminiApiKey) {
    showStatus("먼저 설정에서 Gemini API 키를 입력해주세요.", true);
    els.settingsPanel.classList.remove("hidden");
    return;
  }

  if (!YT_URL_PATTERN.test(videoUrl)) {
    showStatus("올바른 유튜브 주소를 입력해주세요.", true);
    return;
  }

  els.summarizeBtn.disabled = true;

  const model = geminiModel || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: videoUrl } },
          { text: SUMMARY_PROMPT },
        ],
      },
    ],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "low" },
      mediaResolution: "MEDIA_RESOLUTION_LOW",
    },
  };

  log("요약 시작", { model, videoUrl });

  const startedAt = Date.now();
  let phaseMessage = "영상을 분석해 요약하는 중입니다...";
  const elapsedTimer = setInterval(() => {
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
    showStatus(`${phaseMessage} (${sec}초 경과)`, false);
  }, 500);

  showStatus(`${phaseMessage} (0.0초 경과)`, false);

  try {
    const data = await fetchWithRetry(endpoint, geminiApiKey, body, (msg) => {
      phaseMessage = msg;
    });
    clearInterval(elapsedTimer);

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text).filter(Boolean).join("\n").trim();

    if (!text) {
      log("finishReason", data?.candidates?.[0]?.finishReason);
      throw new Error("요약 결과를 가져오지 못했습니다. 비공개/연령 제한 영상이거나 응답이 차단되었을 수 있습니다.");
    }

    log("요약 완료", { textLength: text.length });

    lastSummaryText = text;
    els.resultText.innerHTML = renderSummaryHtml(text, videoUrl);
    els.result.classList.remove("hidden");

    if (extractVideoId(videoUrl)) {
      hideStatus();
    } else {
      log("영상 ID 추출 실패 - 타임스탬프 링크 비활성화", videoUrl);
      showStatus("요약은 완료됐지만, 영상 주소에서 올바른 영상 ID를 찾지 못해 타임스탬프 링크는 만들지 않았습니다.", false);
    }

    // 사이드바를 닫았다 다시 열어도 새로 요약하기 전까지는 이 결과가 그대로 남아있도록 저장.
    // 캐싱 실패는 요약 자체의 실패가 아니므로 별도로 조용히 처리한다.
    try {
      await browserAPI.storage.local.set({ lastSummaryText: text, lastSummaryVideoUrl: videoUrl });
    } catch (storageError) {
      log("요약 결과 캐싱 실패(무시)", storageError);
    }
  } catch (error) {
    log("에러 발생", error);
    showStatus(`오류: ${error.message}`, true);
  } finally {
    clearInterval(elapsedTimer);
    els.summarizeBtn.disabled = false;
  }
}

// 503(UNAVAILABLE)/429(RESOURCE_EXHAUSTED)로 대표되는 "모델 과부하" 에러는
// 몇 초 후 재시도하면 성공하는 경우가 많아 자동으로 재시도한다.
async function fetchWithRetry(endpoint, apiKey, body, onPhaseChange) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      log(`타임아웃으로 요청 중단 (시도 ${attempt}/${MAX_ATTEMPTS})`, `${REQUEST_TIMEOUT_MS}ms 초과`);
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      log(`Gemini API 요청 전송 (시도 ${attempt}/${MAX_ATTEMPTS})`, endpoint.replace(apiKey, "***"));

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = await response.json();
      log("응답 수신", response.status, response.statusText, data);

      if (response.ok) {
        return data;
      }

      const errorStatus = data?.error?.status;
      const isRetryable = RETRYABLE_STATUS_CODES.includes(response.status) || RETRYABLE_ERROR_STATUSES.includes(errorStatus);
      const message = data?.error?.message || `요청 실패 (${response.status})`;

      if (isRetryable && attempt < MAX_ATTEMPTS) {
        log(`서버 과부하(${response.status} ${errorStatus || ""})로 재시도 예정`, `${RETRY_DELAY_MS / 1000}초 후 (${attempt}/${MAX_ATTEMPTS})`);
        onPhaseChange(`서버가 혼잡합니다. ${RETRY_DELAY_MS / 1000}초 후 재시도합니다 (${attempt}/${MAX_ATTEMPTS})...`);

        await sleep(RETRY_DELAY_MS);
        onPhaseChange("영상을 분석해 요약하는 중입니다...");

        continue;
      }

      throw new Error(message);
    } catch (error) {
      if (error.name === "AbortError") {
        if (attempt < MAX_ATTEMPTS) {
          log(`타임아웃으로 재시도 (${attempt}/${MAX_ATTEMPTS})`);
          onPhaseChange(`응답이 지연되고 있습니다. 재시도합니다 (${attempt}/${MAX_ATTEMPTS})...`);
          continue;
        }
        throw new Error(`응답이 ${REQUEST_TIMEOUT_MS / 1000}초 내에 오지 않았습니다. 영상이 너무 길거나 네트워크 문제일 수 있습니다.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function showStatus(message, isError) {
  els.status.textContent = message;
  els.status.classList.remove("hidden");
  els.status.classList.toggle("error", !!isError);
}

function hideStatus() {
  els.status.classList.add("hidden");
}
