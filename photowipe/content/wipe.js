(() => {
  if (window.__photowipeLoaded) return;
  window.__photowipeLoaded = true;

  // Google Photos DOM hooks. If Google changes its markup, this is the only place to update.
  const SEL = {
    accountLink: 'a[aria-label][href^="https://accounts.google.com/SignOutOptions"]',
    emptyLibraryPromo: 'a[href^="https://itunes.apple.com/app/apple-store/id962194608"]',
    scroller: 'c-wiz[role="main"]',
    uncheckedBox: 'div[role="checkbox"][aria-checked="false"][jsaction^="mousedown"]',
    checkedBox: 'div[role="checkbox"][aria-checked="true"]',
    deleteButton: "div[data-delete-origin] button",
    gotItButton: 'div[role="dialog"] button[autofocus]',
    confirmButton: "button[data-mdc-dialog-button-default]",
    toastClose: "aside button[aria-label][data-use-native-focus-logic]",
  };

  // Google Photos can't select more than this in one go.
  const BATCH_SIZE = 1000;
  const PRESETS = [100, 500, 1000];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n) => n.toLocaleString("en-US");

  async function waitUntil(check, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(50);
    }
    return null;
  }

  const waitFor = (selector, timeoutMs) => waitUntil(() => document.querySelector(selector), timeoutMs);

  function parseLimit(value) {
    const n = Math.floor(Number(value));
    return n > 0 ? n : null;
  }

  const isArchive = location.pathname.endsWith("/archive");
  const isTrash = location.pathname.endsWith("/trash");
  const basePath = location.pathname.replace(/\/(archive|trash)$/, "/").replace(/([^/])$/, "$1/");
  const trashUrl = location.origin + basePath + "trash";
  const libraryUrl = location.origin + basePath;

  // Everything that differs between wiping and restoring.
  const plural = (n) => `${fmt(n)} item${n === 1 ? "" : "s"}`;
  const MODE = isTrash
    ? {
        title: "restore from trash",
        hint: "in the order shown in the trash. items go back where they were.",
        go: (n) => (n === null ? "restore everything" : `restore ${fmt(n)}`),
        running: "restoring",
        lastStep: "restore",
        clicking: "clicking restore…",
        working: (n) => `google is restoring ${plural(n)}…`,
        doneHint: "restored items are back in your photos.",
        openLabel: "open photos",
        openUrl: libraryUrl,
        empty: "trash is empty",
        statKey: "totalRestored",
      }
    : {
        title: `clear your ${isArchive ? "archive" : "library"}`,
        hint: "most recent first. items stay in the trash for 60 days.",
        go: (n) => (n === null ? "move everything to trash" : `move ${fmt(n)} to trash`),
        running: "moving to trash",
        lastStep: "trash",
        clicking: "opening the delete dialog…",
        working: (n) => `google is moving ${plural(n)}…`,
        doneHint: "open the trash and hit <b>empty trash</b> to delete them for good.",
        openLabel: "open trash",
        openUrl: trashUrl,
        empty: "nothing to delete",
        statKey: "totalDeleted",
      };

  let limit = parseLimit(new URLSearchParams(location.search).get("limit")); // null = everything
  let stopRequested = false;
  let doneThisRun = 0;
  let startedAt = 0;
  let selectedInBatch = 0;
  let phase = "select"; // select → confirm → trash
  let phaseStartedAt = 0;
  let ticker = null;

  // ---------- UI ----------

  const host = document.createElement("div");
  host.id = "photowipe-root";
  const root = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      :host {
        all: initial;
        --bg: #ffffff;
        --text: #000000;
        --gray: #75757e;
        --button: #f4f4f4;
        --button-hover: #e8e8e8;
        --button-press: #d6d6d6;
        --stroke: rgba(0, 0, 0, .06);
        --input-border: #adadb7;
        --shade: rgba(0, 0, 0, .35);
        --radius: 11px;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg: #000000;
          --text: #e1e1e1;
          --gray: #818181;
          --button: #191919;
          --button-hover: #242424;
          --button-press: #2a2a2a;
          --stroke: rgba(255, 255, 255, .05);
          --input-border: #383838;
          --shade: rgba(0, 0, 0, .6);
        }
      }
      * { box-sizing: border-box; }
      .backdrop { position: fixed; inset: 0; z-index: 2147483646; background: var(--shade); }
      .backdrop.passive { pointer-events: none; background: transparent; }
      .panel {
        position: fixed; z-index: 2147483647;
        top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: min(380px, calc(100vw - 32px));
        display: flex; flex-direction: column; gap: 16px;
        padding: 20px;
        border-radius: 18px;
        background: var(--bg);
        color: var(--text);
        box-shadow: 0 0 0 1px var(--stroke), 0 10px 40px rgba(0, 0, 0, .18);
        font: 14.5px/1.4 "IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
        -webkit-font-smoothing: antialiased;
      }
      .backdrop.passive + .panel { top: auto; left: auto; right: 24px; bottom: 24px; transform: none; }
      .label { font-size: 12.5px; color: var(--gray); }
      .title { font-size: 16px; font-weight: 600; margin: 0; }
      p { margin: 0; font-size: 13px; color: var(--gray); }
      b { color: var(--text); font-weight: 500; }
      .group { display: flex; flex-direction: column; gap: 8px; }
      .seg { display: flex; gap: 6px; }
      .seg button { flex: 1; }
      .stack { display: flex; flex-direction: column; gap: 6px; }
      button, input { font: inherit; color: var(--text); border-radius: var(--radius); }
      button {
        border: 0; cursor: pointer; padding: 8px 13px;
        background: var(--button);
        box-shadow: 0 0 0 1px var(--stroke) inset;
      }
      button:hover { background: var(--button-hover); }
      button:active { background: var(--button-press); }
      button.primary, .seg button.active { background: var(--text); color: var(--bg); }
      button.primary:hover, .seg button.active:hover { background: var(--text); opacity: .88; }
      button.primary { padding: 10px 13px; font-weight: 500; }
      button:disabled { opacity: .4; cursor: default; }
      input {
        width: 100%; padding: 8px 12px; border: 0; outline: none;
        background: var(--button); box-shadow: 0 0 0 1px var(--stroke) inset;
      }
      input:focus { box-shadow: 0 0 0 1.5px var(--input-border) inset; }
      input::placeholder { color: var(--gray); }
      input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .count { font-size: 30px; font-weight: 500; line-height: 1; letter-spacing: -.5px; }
      .count small { font-size: 14.5px; color: var(--gray); letter-spacing: 0; }
      .bar { position: relative; height: 4px; border-radius: 4px; background: var(--button-hover); overflow: hidden; }
      .bar > i { position: absolute; left: 0; top: 0; display: block; height: 100%; width: 0; background: var(--text); transition: width .3s ease; }
      .bar > i.pending { opacity: .3; }
      .bar.busy > i.pending { animation: pulse 1.1s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: .12; } }
      .bar.indeterminate > i { width: 30%; animation: slide 1.2s linear infinite; }
      @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
      .steps { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 12.5px; }
      .steps li { flex: 1; padding: 6px 0; text-align: center; border-radius: 8px; color: var(--gray); background: var(--button); }
      .steps li.active { color: var(--bg); background: var(--text); }
      .steps li.past { color: var(--text); }
      .sub { font-size: 12.5px; color: var(--gray); min-height: 1.4em; }
      .meta { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; color: var(--gray); }
    </style>
    <div class="backdrop"></div>
    <div class="panel"></div>
  `;

  const backdrop = root.querySelector(".backdrop");
  const panel = root.querySelector(".panel");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function render(html, { blockClicks = true } = {}) {
    backdrop.classList.toggle("passive", !blockClicks);
    panel.dataset.screen = "";
    panel.innerHTML = `<span class="label">photowipe</span>${html}`;
  }

  const $ = (selector) => root.querySelector(selector);
  const on = (selector, handler) => $(selector)?.addEventListener("click", handler);
  const closePanel = () => host.remove();

  function countLine() {
    return `<div class="count">${fmt(doneThisRun)}${limit ? ` <small>/ ${fmt(limit)}</small>` : ""}</div>`;
  }

  // ---------- Screens ----------

  function showLoading() {
    render(`<p>looking for your google account…</p><div class="bar indeterminate"><i></i></div>`);
  }

  function showLoggedOut() {
    render(`
      <h1 class="title">sign in first</h1>
      <p>you need to be signed in to google photos.</p>
      <div class="stack">
        <button class="primary" id="login">sign in</button>
        <button id="close">close</button>
      </div>`);
    on("#login", () => (location.href = "https://photos.google.com/login" + location.search));
    on("#close", closePanel);
  }

  function showConfirm(account) {
    render(`
      <h1 class="title">${MODE.title}</h1>
      <p>account: <b>${esc(account)}</b></p>
      <div class="group">
        <span class="label">how many</span>
        <div class="seg">
          ${PRESETS.map((n) => `<button data-value="${n}">${n}</button>`).join("")}
          <button data-value="all">all</button>
        </div>
        <input id="amount" type="number" min="1" step="1" inputmode="numeric" placeholder="custom amount" />
        <p>${MODE.hint}</p>
      </div>
      <div class="stack">
        <button class="primary" id="go"></button>
        <button id="switch">use another account</button>
        <button id="cancel">cancel</button>
      </div>`);

    const input = $("#amount");
    const go = $("#go");
    let draft = limit;
    input.value = draft ?? "";

    function sync() {
      for (const b of root.querySelectorAll(".seg button")) {
        b.classList.toggle("active", b.dataset.value === (draft === null ? "all" : String(draft)));
      }
      const valid = draft === null || draft > 0;
      go.disabled = !valid;
      go.textContent = valid ? MODE.go(draft) : "enter a number";
    }

    $(".seg").addEventListener("click", (e) => {
      const v = e.target.closest("button")?.dataset.value;
      if (!v) return;
      draft = v === "all" ? null : Number(v);
      input.value = draft ?? "";
      sync();
    });
    input.addEventListener("input", () => {
      draft = input.value === "" ? null : parseLimit(input.value) ?? 0;
      sync();
    });
    on("#go", () => {
      limit = draft;
      chrome.storage.local.get({ prefs: {} }, ({ prefs }) =>
        chrome.storage.local.set({ prefs: { ...prefs, limit } }));
      run();
    });
    on("#switch", switchAccount);
    on("#cancel", closePanel);
    sync();
  }

  // The running screen is mounted once and then patched in place,
  // so the stop button never gets swapped out from under the cursor.
  function mountRunning() {
    render(`
      <h1 class="title">${MODE.running}</h1>
      <div class="count"><span id="done">0</span>${limit ? ` <small>/ ${fmt(limit)}</small>` : ""}</div>
      <div class="sub" id="selected"></div>
      ${limit
        ? `<div class="bar" id="bar"><i class="pending"></i><i class="solid"></i></div>`
        : `<div class="bar indeterminate"><i></i></div>`}
      <ol class="steps">
        <li data-step="select">1 select</li>
        <li data-step="confirm">2 confirm</li>
        <li data-step="trash">3 ${MODE.lastStep}</li>
      </ol>
      <div class="meta"><span id="status"></span><span id="timer"></span></div>
      <p>keep this tab open and don't click on the page.</p>
      <button id="stop">stop</button>`);
    panel.dataset.screen = "running";
    on("#stop", () => {
      stopRequested = true;
      const btn = $("#stop");
      btn.disabled = true;
      btn.textContent = "stopping after this step…";
    });
  }

  function updateRunning(status) {
    if (panel.dataset.screen !== "running") mountRunning();

    $("#done").textContent = fmt(doneThisRun);
    $("#selected").textContent = selectedInBatch
      ? `${fmt(selectedInBatch)} ${phase === "select" ? "selected so far" : "in this batch"}`
      : "";

    if (limit) {
      const pct = (n) => `${Math.min(100, (n / limit) * 100)}%`;
      $("#bar .solid").style.width = pct(doneThisRun);
      $("#bar .pending").style.width = pct(doneThisRun + selectedInBatch);
      $("#bar").classList.toggle("busy", phase !== "select");
    }

    const order = ["select", "confirm", "trash"];
    for (const li of root.querySelectorAll(".steps li")) {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle("active", i === order.indexOf(phase));
      li.classList.toggle("past", i < order.indexOf(phase));
    }

    if (status !== undefined) $("#status").textContent = status;
    tick();
  }

  function tick() {
    const timer = $("#timer");
    if (!timer) return;
    const secs = Math.floor((Date.now() - phaseStartedAt) / 1000);
    const mins = (Date.now() - startedAt) / 60000;
    const rate = doneThisRun && mins > 0.2 ? ` · ${fmt(Math.round(doneThisRun / mins))}/min` : "";
    timer.textContent = `${secs}s${rate}`;
  }

  function setPhase(next, status) {
    phase = next;
    phaseStartedAt = Date.now();
    updateRunning(status);
  }

  function showDone({ stopped = false, error = "" } = {}) {
    clearInterval(ticker);
    document.title = document.title.replace(/^\[(done|error)\] /, "");
    document.title = `[${error ? "error" : "done"}] ${document.title}`;
    const remaining = limit ? limit - doneThisRun : null;
    const canContinue = (stopped || error) && remaining !== 0;
    const title = error ? "something went wrong" : stopped ? "stopped" : doneThisRun ? "done" : MODE.empty;

    render(`
      <h1 class="title">${title}</h1>
      ${countLine()}
      ${error ? `<p>${esc(error)}</p>` : ""}
      ${doneThisRun ? `<p>${MODE.doneHint}</p>` : ""}
      <div class="stack">
        <button class="primary" id="open">${MODE.openLabel}</button>
        ${canContinue ? `<button id="again">continue${remaining ? ` (${fmt(remaining)} left)` : ""}</button>` : ""}
        <button id="close">close</button>
      </div>`, { blockClicks: false });

    on("#open", () => (location.href = MODE.openUrl));
    on("#again", () => {
      // After an error the page may be in a weird state, so reload with what's left.
      const params = new URLSearchParams(location.search);
      if (remaining) params.set("limit", remaining);
      else params.delete("limit");
      location.href = location.pathname + "?" + params.toString().replace(/^photowipe=(&|$)/, "photowipe$1");
    });
    on("#close", closePanel);
  }

  // ---------- Google Photos automation ----------

  function readAccountName() {
    const label = document.querySelector(SEL.accountLink)?.getAttribute("aria-label");
    if (!label) return null;
    // e.g. "Google Account: Jane Doe, (jane@gmail.com)". The prefix depends on the language.
    const name = label.split(/^.*(?::|：|Compte Google)\s/)[2] ?? label;
    return name.split(",")[0].trim() || label;
  }

  function switchAccount() {
    const href = document.querySelector(SEL.accountLink)?.getAttribute("href");
    if (href) location.href = href;
  }

  function libraryLooksEmpty() {
    return !isTrash && Boolean(document.querySelector(SEL.emptyLibraryPromo)?.offsetParent);
  }

  // The restore button has no stable attribute, so match its label in the common UI languages.
  const RESTORE_LABEL = /restor|restaur|wiederherst|ripristin|herstel|przywr|geri yükle|восстан|復元|恢复|還原|복원/i;

  function findRestoreButton() {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!el.offsetParent || host.contains(el)) continue;
      const label = el.getAttribute("aria-label") || el.textContent || "";
      if (RESTORE_LABEL.test(label.trim())) return el;
    }
    return null;
  }

  async function selectBatch(max) {
    if (libraryLooksEmpty()) return 0;
    const scroller = document.querySelector(SEL.scroller);
    scroller?.scrollBy(0, 500);
    await sleep(500);

    let selected = 0;
    let retries = 10;
    while (selected < max && !stopRequested) {
      const boxes = document.querySelectorAll(SEL.uncheckedBox);
      if (boxes.length) {
        for (const box of boxes) {
          if (selected >= max) break;
          box.click();
          selected++;
        }
        boxes[boxes.length - 1].scrollIntoView();
        retries = 10;
        selectedInBatch = selected;
        updateRunning("selecting photos…");
      } else if (retries > 0) {
        scroller?.scrollBy(0, 1000);
        retries--;
        await sleep(500);
      } else {
        break;
      }
      await sleep(300);
    }
    return selected;
  }

  async function restoreSelection(count) {
    setPhase("confirm", MODE.clicking);
    const btn = await waitUntil(findRestoreButton, 3000);
    if (!btn) throw new Error("couldn't find the restore button. google may have changed its layout, try reloading.");
    btn.click();

    // Some accounts get a confirmation dialog, most don't.
    (await waitFor(SEL.confirmButton, 1500))?.click();

    setPhase("trash", MODE.working(count));
    // Done when Google shows its "restored" toast, or the selection has stayed cleared for a few seconds.
    let clearedSince = 0;
    const finished = await waitUntil(() => {
      const toast = document.querySelector(SEL.toastClose);
      if (toast) return toast;
      if (document.querySelector(SEL.checkedBox)) clearedSince = 0;
      else clearedSince ||= Date.now();
      return clearedSince && Date.now() - clearedSince > 4000;
    }, 5 * 60 * 1000);
    if (!finished) throw new Error("google photos took too long to restore. reload to continue.");
    if (finished instanceof Element) finished.click();
  }

  async function trashSelection(count) {
    setPhase("confirm", MODE.clicking);
    const del = await waitFor(SEL.deleteButton, 3000);
    if (!del) throw new Error("couldn't find the delete button. google may have changed its layout, try reloading.");
    del.click();

    (await waitFor(SEL.gotItButton, 500))?.click();
    (await waitFor(SEL.confirmButton, 30000))?.click();

    setPhase("trash", MODE.working(count));
    // The "moved to trash" toast appears once Google has finished; big batches can take a while.
    const toastClose = await waitFor(SEL.toastClose, 5 * 60 * 1000);
    if (!toastClose) throw new Error("google photos took too long to confirm. reload to continue.");
    toastClose.click();
  }

  async function saveProgress(count) {
    const { [MODE.statKey]: total = 0 } = await chrome.storage.local.get(MODE.statKey);
    await chrome.storage.local.set({ [MODE.statKey]: total + count, lastRunAt: Date.now() });
  }

  async function run() {
    stopRequested = false;
    doneThisRun = 0;
    startedAt = Date.now();
    selectedInBatch = 0;
    setPhase("select", "starting…");
    clearInterval(ticker);
    ticker = setInterval(tick, 1000);
    try {
      while (!stopRequested) {
        const remaining = limit ? limit - doneThisRun : BATCH_SIZE;
        if (remaining <= 0) break;
        setPhase("select", "selecting photos…");
        const count = await selectBatch(Math.min(BATCH_SIZE, remaining));
        if (count === 0 || stopRequested) break;
        await (isTrash ? restoreSelection(count) : trashSelection(count));
        doneThisRun += count;
        selectedInBatch = 0;
        await saveProgress(count);
        updateRunning("batch done");
      }
      showDone({ stopped: stopRequested });
    } catch (err) {
      console.error("[photowipe]", err);
      showDone({ error: err.message });
    }
  }

  // ---------- Boot ----------

  (async () => {
    showLoading();
    await waitFor(SEL.scroller, 15000);
    await waitFor(SEL.accountLink, 5000);
    const account = readAccountName();
    if (!account) showLoggedOut();
    else showConfirm(account);
  })();
})();
