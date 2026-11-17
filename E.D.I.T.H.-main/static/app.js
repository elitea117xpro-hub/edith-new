const state = {
  user: null,
  contacts: [],
  conversations: [],
  activeConversation: null,
  activeMessages: [],
  ws: null,
  deferredInstall: null,
  pc: null,
  localStream: null,
  currentCall: null,
  incomingOffer: null,
  queuedIce: [],
  callStartedAt: null,
  callTimer: null,
  microphoneId: "",
  speakerId: "",
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function show(element, visible = true) {
  element?.classList.toggle("hidden", !visible);
}

function initials(value = "?") {
  return value.trim().slice(0, 2).toUpperCase() || "?";
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("show"), 2800);
}

function showError(message, target = $("#auth-error")) {
  if (target) target.textContent = message || "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "The network returned an error.");
  return data;
}

function switchAuthTab(tab) {
  $$("[data-auth-tab]").forEach((button) => button.classList.toggle("active", button.dataset.authTab === tab));
  show($("#login-form"), tab === "login");
  show($("#register-form"), tab === "register");
  showError("");
}

$$('[data-auth-tab]').forEach((button) => button.addEventListener("click", () => switchAuthTab(button.dataset.authTab)));

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget));
  showError("OPENING CHANNEL…");
  try {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
    await enterApp(data.user);
  } catch (error) {
    showError(error.message);
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget));
  showError("INITIALIZING IDENTITY…");
  try {
    const data = await api("/api/auth/register", { method: "POST", body: JSON.stringify(payload) });
    await enterApp(data.user);
  } catch (error) {
    showError(error.message);
  }
});

async function enterApp(user) {
  state.user = user;
  $("#identity-label").textContent = `@${user.username}`;
  $("#identity-avatar").textContent = initials(user.display_name);
  show($("#auth-screen"), false);
  show($("#app-screen"), true);
  await Promise.all([loadContacts(), loadConversations(), loadConfig()]);
  connectWebSocket();
  enumerateDevices();
  registerInstallPrompt();
}

async function restoreSession() {
  try {
    const data = await api("/api/me");
    await enterApp(data.user);
  } catch {
    show($("#auth-screen"), true);
  }
}

$("#logout-button").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.ws?.close();
  window.location.reload();
});

async function loadConfig() {
  try {
    const data = await api("/api/config");
    state.iceServers = data.ice_servers || state.iceServers;
  } catch {
    // The development STUN fallback remains usable.
  }
}

async function loadContacts() {
  const data = await api("/api/contacts");
  state.contacts = data.contacts;
  renderContacts();
  updateOnlineSummary();
}

async function loadConversations() {
  const data = await api("/api/conversations");
  state.conversations = data.conversations;
  renderConversations();
}

function contactItem(contact, conversation = null) {
  const item = document.createElement("div");
  item.className = `list-item ${state.activeConversation?.contact?.id === contact.id ? "active" : ""}`;
  item.dataset.contactId = contact.id;
  item.innerHTML = `<div class="avatar">${initials(contact.display_name)}</div><div class="list-item-copy"><h4>${escapeHtml(contact.display_name)}</h4><p>@${escapeHtml(contact.username)}${contact.online ? " · ONLINE" : ""}</p></div><div class="list-item-meta">${conversation?.last_message_at ? formatTime(conversation.last_message_at) : ""}</div>`;
  item.addEventListener("click", () => openConversation(contact.id));
  return item;
}

function renderConversations() {
  const list = $("#list-content");
  list.innerHTML = "";
  const byId = new Map(state.contacts.map((contact) => [contact.id, contact]));
  state.conversations.forEach((conversation) => {
    const contact = { ...conversation.contact, ...(byId.get(conversation.contact.id) || {}) };
    list.appendChild(contactItem(contact, conversation));
  });
  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-list"><p class="eyebrow">NO OPEN THREADS</p><p class="presence-label">Add a contact to initialize a channel.</p></div>`;
  }
}

function renderContacts() {
  const list = $("#contacts-grid");
  list.innerHTML = "";
  if (!state.contacts.length) {
    list.innerHTML = `<div class="empty-list"><p class="eyebrow">DIRECTORY EMPTY</p><p class="presence-label">Add someone by their exact username.</p></div>`;
    return;
  }
  state.contacts.forEach((contact) => {
    const card = document.createElement("div");
    card.className = "contact-card";
    card.innerHTML = `<div class="avatar">${initials(contact.display_name)}</div><div class="contact-card-copy"><h4>${escapeHtml(contact.display_name)}</h4><p>@${escapeHtml(contact.username)} · <span class="${contact.online ? "online" : ""}">${contact.online ? "ONLINE" : "OFFLINE"}</span></p></div><button type="button">OPEN</button>`;
    card.querySelector("button").addEventListener("click", () => openConversation(contact.id));
    list.appendChild(card);
  });
}

function updateOnlineSummary() {
  const online = state.contacts.filter((contact) => contact.online).length;
  $("#online-summary").textContent = `${online} ONLINE · ${state.contacts.length} CONTACT${state.contacts.length === 1 ? "" : "S"}`;
}

async function openConversation(contactId) {
  try {
    const data = await api(`/api/conversations/${contactId}`, { method: "POST", body: "{}" });
    state.activeConversation = data.conversation;
    const messages = await api(`/api/conversations/${state.activeConversation.id}/messages`);
    state.activeMessages = messages.messages;
    renderActiveConversation();
    await loadConversations();
    switchView("messages");
  } catch (error) {
    toast(error.message);
  }
}

function renderActiveConversation() {
  const conversation = state.activeConversation;
  if (!conversation) return;
  show($("#empty-conversation"), false);
  show($("#active-conversation"), true);
  $("#conversation-name").textContent = conversation.contact.display_name;
  $("#conversation-avatar").textContent = initials(conversation.contact.display_name);
  setPresenceLabel(conversation.contact.online);
  const stream = $("#message-stream");
  stream.innerHTML = "";
  state.activeMessages.forEach((message) => appendMessage(message, false));
  stream.scrollTop = stream.scrollHeight;
  $$(".list-item").forEach((item) => item.classList.toggle("active", Number(item.dataset.contactId) === conversation.contact.id));
}

function setPresenceLabel(online) {
  const label = $("#conversation-presence");
  label.textContent = online ? "ONLINE · READY" : "OFFLINE · LAST SEEN UNAVAILABLE";
  label.classList.toggle("online", online);
}

function appendMessage(message, scroll = true) {
  if (!state.activeConversation || message.conversation_id !== state.activeConversation.id) return;
  if (state.activeMessages.some((existing) => existing.id === message.id)) return;
  state.activeMessages.push(message);
  const mine = message.sender_id === state.user.id;
  const node = document.createElement("div");
  node.className = `message ${mine ? "mine" : ""}`;
  node.innerHTML = `<div class="message-bubble">${escapeHtml(message.body).replace(/\n/g, "<br />")}</div><div class="message-meta">${mine ? "YOU" : escapeHtml(state.activeConversation.contact.username)} · ${formatTime(message.created_at)}</div>`;
  $("#message-stream").appendChild(node);
  if (scroll) $("#message-stream").scrollTop = $("#message-stream").scrollHeight;
}

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const body = input.value.trim();
  if (!body || !state.activeConversation) return;
  input.value = "";
  try {
    await api(`/api/conversations/${state.activeConversation.id}/messages`, { method: "POST", body: JSON.stringify({ body }) });
    await loadConversations();
  } catch (error) {
    toast(error.message);
    input.value = body;
  }
});

$("#new-contact-button").addEventListener("click", addContactPrompt);
$("#contacts-add-button").addEventListener("click", addContactPrompt);

async function addContactPrompt() {
  const username = window.prompt("Enter their exact E.D.I.T.H. username:");
  if (!username?.trim()) return;
  try {
    const data = await api("/api/contacts", { method: "POST", body: JSON.stringify({ username: username.trim() }) });
    await loadContacts();
    await openConversation(data.contact.id);
    toast(`@${data.contact.username} added to your network.`);
  } catch (error) {
    toast(error.message);
  }
}

let searchTimer;
$("#global-search").addEventListener("input", (event) => {
  window.clearTimeout(searchTimer);
  const query = event.target.value.trim();
  if (query.length < 2) {
    show($("#search-results"), false);
    show($("#list-content"), true);
    return;
  }
  searchTimer = window.setTimeout(() => searchUsers(query), 220);
});

async function searchUsers(query) {
  try {
    const data = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
    const results = $("#search-results");
    results.innerHTML = data.users.length ? "" : `<p class="presence-label">No operators found.</p>`;
    data.users.forEach((user) => {
      const row = document.createElement("div");
      row.className = "search-result";
      row.innerHTML = `<div class="search-result-info"><strong>${escapeHtml(user.display_name)}</strong><span>@${escapeHtml(user.username)} · ${user.online ? "ONLINE" : "OFFLINE"}</span></div><button class="secondary-button" type="button">ADD</button>`;
      row.querySelector("button").addEventListener("click", async () => {
        try { await api("/api/contacts", { method: "POST", body: JSON.stringify({ username: user.username }) }); await loadContacts(); toast(`@${user.username} added.`); } catch (error) { toast(error.message); }
      });
      results.appendChild(row);
    });
    show($("#list-content"), false);
    show(results, true);
  } catch (error) {
    toast(error.message);
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
  state.ws.addEventListener("open", () => {
    $("#connection-state").innerHTML = `<span class="status-dot"></span> CONNECTED`;
  });
  state.ws.addEventListener("close", () => {
    $("#connection-state").innerHTML = `<span class="status-dot" style="background:var(--amber);box-shadow:0 0 13px var(--amber)"></span> RECONNECTING`;
    if (state.user) window.setTimeout(connectWebSocket, 1800);
  });
  state.ws.addEventListener("message", (event) => handleRealtime(JSON.parse(event.data)));
}

function sendRealtime(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function handleRealtime(payload) {
  if (payload.type === "presence") {
    const online = new Set(payload.online_user_ids);
    state.contacts = state.contacts.map((contact) => ({ ...contact, online: online.has(contact.id) }));
    if (state.activeConversation) state.activeConversation.contact.online = online.has(state.activeConversation.contact.id);
    renderConversations(); renderContacts(); updateOnlineSummary();
    if (state.activeConversation) setPresenceLabel(state.activeConversation.contact.online);
  } else if (payload.type === "message") {
    appendMessage(payload.message);
    loadConversations();
  } else if (["call-offer", "call-answer", "ice-candidate", "call-decline", "call-end", "call-busy"].includes(payload.type)) {
    handleCallSignal(payload);
  }
}

async function startCall(kind) {
  if (!state.activeConversation) return toast("Open a conversation before starting a call.");
  try {
    await preparePeerConnection(kind, state.activeConversation.contact.id);
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    state.currentCall = { kind, targetUserId: state.activeConversation.contact.id, conversationId: state.activeConversation.id, role: "caller" };
    showActiveCall();
    sendRealtime({ type: "call-offer", to_user_id: state.currentCall.targetUserId, call_type: kind, conversation_id: state.currentCall.conversationId, sdp: state.pc.localDescription });
  } catch (error) {
    closeCall(false);
    showError(error.message, $("#call-error"));
  }
}

async function preparePeerConnection(kind, targetUserId) {
  const audio = state.microphoneId ? { deviceId: { exact: state.microphoneId } } : true;
  const video = kind === "video" ? (state.cameraEnabled === false ? false : true) : false;
  state.localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
  state.pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.localStream.getTracks().forEach((track) => state.pc.addTrack(track, state.localStream));
  state.pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) sendRealtime({ type: "ice-candidate", to_user_id: targetUserId, candidate: event.candidate });
  });
  state.pc.addEventListener("track", (event) => {
    const remote = $("#remote-video");
    remote.srcObject = event.streams[0];
    applySpeaker(remote);
  });
  state.pc.addEventListener("connectionstatechange", () => {
    if (["failed", "disconnected"].includes(state.pc?.connectionState)) showError("The peer link lost network connectivity.", $("#call-error"));
  });
}

function showIncomingCall(payload) {
  state.incomingOffer = payload;
  $("#incoming-call-name").textContent = payload.from_username;
  $("#incoming-call-handle").textContent = `@${payload.from_username}`;
  $("#incoming-call-kind").textContent = (payload.call_type || "voice").toUpperCase();
  show($("#call-layer"), true); show($("#incoming-call-card"), true); show($("#active-call-card"), false);
}

async function acceptIncomingCall() {
  const payload = state.incomingOffer;
  if (!payload) return;
  try {
    const contact = state.contacts.find((item) => item.id === payload.from_user_id);
    state.activeConversation = contact ? (state.conversations.find((item) => item.contact.id === contact.id) || { id: payload.conversation_id, contact }) : state.activeConversation;
    await preparePeerConnection(payload.call_type || "voice", payload.from_user_id);
    state.currentCall = { kind: payload.call_type || "voice", targetUserId: payload.from_user_id, conversationId: payload.conversation_id, role: "callee" };
    await state.pc.setRemoteDescription(payload.sdp);
    for (const candidate of state.queuedIce) await state.pc.addIceCandidate(candidate);
    state.queuedIce = [];
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    sendRealtime({ type: "call-answer", to_user_id: payload.from_user_id, sdp: state.pc.localDescription });
    showActiveCall();
    state.incomingOffer = null;
  } catch (error) {
    closeCall(false); showError(error.message, $("#call-error"));
  }
}

async function handleCallSignal(payload) {
  if (payload.type === "call-offer") {
    if (state.currentCall) { sendRealtime({ type: "call-busy", to_user_id: payload.from_user_id }); return; }
    showIncomingCall(payload);
    return;
  }
  if (payload.type === "call-answer" && state.pc) {
    await state.pc.setRemoteDescription(payload.sdp);
    for (const candidate of state.queuedIce) await state.pc.addIceCandidate(candidate);
    state.queuedIce = [];
  } else if (payload.type === "ice-candidate") {
    if (state.pc?.remoteDescription) await state.pc.addIceCandidate(payload.candidate);
    else state.queuedIce.push(payload.candidate);
  } else if (payload.type === "call-decline" || payload.type === "call-busy") {
    toast(payload.type === "call-busy" ? "That operator is already on another link." : "The incoming link was declined.");
    closeCall(false);
  } else if (payload.type === "call-end") {
    toast("The other operator ended the link.");
    closeCall(false);
  }
}

function showActiveCall() {
  show($("#call-layer"), true); show($("#incoming-call-card"), false); show($("#active-call-card"), true);
  $("#active-call-name").textContent = state.activeConversation?.contact?.display_name || state.incomingOffer?.from_username || "Operator";
  const video = state.currentCall?.kind === "video";
  $("#call-status-label").textContent = video ? "SECURE VIDEO LINK" : "SECURE VOICE LINK";
  show($("#video-stage"), true);
  show($("#audio-avatar"), !video);
  $("#remote-video").style.display = video ? "block" : "none";
  $("#local-video").style.display = video ? "block" : "none";
  if (video && state.localStream) $("#local-video").srcObject = state.localStream;
  populateCallDevices();
  state.callStartedAt = new Date().toISOString();
  window.clearInterval(state.callTimer);
  state.callTimer = window.setInterval(updateCallDuration, 1000);
  updateCallDuration();
}

function updateCallDuration() {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(state.callStartedAt || Date.now()).getTime()) / 1000));
  $("#call-duration").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function closeCall(notifyPeer = true) {
  if (notifyPeer && state.currentCall) sendRealtime({ type: "call-end", to_user_id: state.currentCall.targetUserId });
  const call = state.currentCall;
  if (call?.conversationId && state.callStartedAt) api("/api/calls/history", { method: "POST", body: JSON.stringify({ conversation_id: call.conversationId, call_type: call.kind, started_at: state.callStartedAt, ended_at: new Date().toISOString() }) }).catch(() => {});
  state.pc?.close(); state.pc = null;
  state.localStream?.getTracks().forEach((track) => track.stop()); state.localStream = null;
  state.currentCall = null; state.incomingOffer = null; state.queuedIce = [];
  window.clearInterval(state.callTimer); state.callTimer = null;
  $("#remote-video").srcObject = null; $("#local-video").srcObject = null;
  show($("#call-layer"), false);
}

$("#voice-call-button").addEventListener("click", () => startCall("voice"));
$("#video-call-button").addEventListener("click", () => startCall("video"));
$("#accept-call-button").addEventListener("click", acceptIncomingCall);
$("#decline-call-button").addEventListener("click", () => { if (state.incomingOffer) sendRealtime({ type: "call-decline", to_user_id: state.incomingOffer.from_user_id }); closeCall(false); });
$("#hangup-call-button").addEventListener("click", () => closeCall(true));
$("#mute-call-button").addEventListener("click", (event) => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.currentTarget.textContent = track.enabled ? "MIC ON" : "MIC MUTED";
  event.currentTarget.classList.toggle("accent", !track.enabled);
});
$("#camera-call-button").addEventListener("click", (event) => {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  event.currentTarget.textContent = track.enabled ? "CAMERA ON" : "CAMERA OFF";
});

async function enumerateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    $("#device-message").textContent = "This browser does not expose audio-device selection.";
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === "audioinput");
    const speakers = devices.filter((device) => device.kind === "audiooutput");
    fillDeviceSelect($("#microphone-select"), microphones, "System default");
    fillDeviceSelect($("#speaker-select"), speakers, "System default");
    fillDeviceSelect($("#call-mic-select"), microphones, "MIC · DEFAULT");
    fillDeviceSelect($("#call-speaker-select"), speakers, "OUT · DEFAULT");
    $("#device-message").textContent = devices.some((device) => device.label) ? "Device labels are available for this session." : "Start a call to grant permission and reveal device labels.";
  } catch (error) { $("#device-message").textContent = error.message; }
}

function fillDeviceSelect(select, devices, defaultLabel) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${defaultLabel}</option>`;
  devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${device.kind === "audioinput" ? "Microphone" : "Speaker"} ${index + 1}`;
    select.appendChild(option);
  });
  if (current) select.value = current;
}

$("#microphone-select").addEventListener("change", (event) => { state.microphoneId = event.target.value; $("#call-mic-select").value = state.microphoneId; });
$("#speaker-select").addEventListener("change", (event) => { state.speakerId = event.target.value; $("#call-speaker-select").value = state.speakerId; applySpeaker($("#remote-video")); });
$("#call-mic-select").addEventListener("change", (event) => { state.microphoneId = event.target.value; $("#microphone-select").value = state.microphoneId; });
$("#call-speaker-select").addEventListener("change", (event) => { state.speakerId = event.target.value; $("#speaker-select").value = state.speakerId; applySpeaker($("#remote-video")); });

function applySpeaker(mediaElement) {
  if (!mediaElement || !state.speakerId) return;
  if (typeof mediaElement.setSinkId === "function") mediaElement.setSinkId(state.speakerId).catch(() => {});
  else showError("This browser does not support speaker routing; audio will use the system default.", $("#call-error"));
}

function switchView(view) {
  const messages = view === "messages";
  const contacts = view === "contacts";
  const devices = view === "devices";
  show($("#list-panel"), messages);
  show($("#conversation-panel"), messages);
  show($("#contacts-panel"), contacts);
  show($("#devices-panel"), devices);
  $("#view-title").textContent = messages ? "LIVE THREADS" : contacts ? "CONTACT DIRECTORY" : "DEVICE CONTROLS";
  $$(".rail-button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
}

$$(".rail-button[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));

function registerInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); state.deferredInstall = event; show($("#install-button"), true);
  });
}

$("#install-button").addEventListener("click", async () => {
  if (!state.deferredInstall) return toast("Use your browser menu to install E.D.I.T.H. as an app.");
  state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; show($("#install-button"), false);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/static/sw.js").catch(() => {}));
restoreSession();
