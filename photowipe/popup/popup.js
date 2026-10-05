const fmt = new Intl.NumberFormat("en-US");

const mode = document.getElementById("mode");
const presets = document.getElementById("presets");
const amountInput = document.getElementById("amount");
const orderHint = document.getElementById("order-hint");
const source = document.getElementById("source");
const sourceBlock = document.getElementById("source-block");
const startBtn = document.getElementById("start");
const summary = document.getElementById("summary");

// limit: positive integer, or null for "all"
let state = { mode: "delete", limit: 500, source: "library" };

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function setActive(group, value) {
  for (const btn of group.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.value === value);
  }
}

function render() {
  const restoring = state.mode === "restore";
  setActive(mode, state.mode);
  setActive(presets, state.limit === null ? "all" : String(state.limit));
  setActive(source, state.source);
  sourceBlock.hidden = restoring;
  orderHint.textContent = restoring
    ? "items are restored in the order shown in the trash."
    : "most recent photos are removed first.";

  const valid = state.limit === null || state.limit > 0;
  const what = `${state.limit === null ? "every" : fmt.format(state.limit)} item${state.limit === 1 ? "" : "s"}`;
  startBtn.disabled = !valid;
  startBtn.textContent = restoring ? "start restoring" : "start";
  summary.textContent = !valid
    ? "enter a number above 0."
    : restoring
      ? `${what} from your trash will be restored.`
      : `${what} from your ${state.source} will go to trash.`;
}

function save() {
  chrome.storage.local.set({ prefs: state });
}

function onSegment(group, apply) {
  group.addEventListener("click", (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (!value) return;
    apply(value);
    render();
    save();
  });
}

onSegment(mode, (v) => (state.mode = v));
onSegment(source, (v) => (state.source = v));
onSegment(presets, (v) => {
  state.limit = v === "all" ? null : Number(v);
  amountInput.value = state.limit ?? "";
});

amountInput.addEventListener("input", () => {
  const n = Math.floor(Number(amountInput.value));
  state.limit = amountInput.value === "" ? null : n > 0 ? n : 0;
  render();
  save();
});

startBtn.addEventListener("click", () => {
  const params = new URLSearchParams({ photowipe: "" });
  if (state.limit) params.set("limit", state.limit);
  const query = params.toString().replace("photowipe=", "photowipe");
  const path = state.mode === "restore" ? "trash" : state.source === "archive" ? "archive" : "login";
  chrome.tabs.create({ url: `https://photos.google.com/${path}?${query}` });
  window.close();
});

chrome.storage.local.get(
  { totalDeleted: 0, totalRestored: 0, lastRunAt: 0, prefs: null },
  ({ totalDeleted, totalRestored, lastRunAt, prefs }) => {
    if (prefs) state = { ...state, ...prefs };
    amountInput.value = state.limit ?? "";
    document.getElementById("stats").textContent =
      `${fmt.format(totalDeleted)} trashed · ${fmt.format(totalRestored)} restored` +
      (lastRunAt ? ` · last run ${timeAgo(lastRunAt)}` : "");
    render();
  },
);

// The options page reuses this file; center it in the tab.
if (window.innerWidth > 600) document.body.classList.add("full");
