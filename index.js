/**
 * Cast Memory — long-term memory + character persistence for SillyTavern.
 *
 * Architecture (merged edition of Stockpile Memory):
 *  - The MAIN model declares scene presence with tiny HTML-comment blocks
 *    (login / logout), and introduces characters with a profile block.
 *    The extension parses and strips those blocks, keeping a cast roster.
 *  - A SUB model (any connection profile / endpoint) writes memories.
 *    When a scene closes (everyone logged out, a token threshold, or a
 *    manual tap), the sub model reads the scene and writes, for each
 *    participant, that character's OWN subjective memories, plus shared
 *    world-memory entries. Characters who were not present get nothing —
 *    information asymmetry is structural, not prompted.
 *  - A generate_interceptor splices a <cast_memory> block into the exact
 *    outgoing chat array: world memory, the profiles + memories of the
 *    characters currently on stage, and the full roster. Raw history is
 *    kept only for the current scene plus a short tail; older messages
 *    are flagged with ST's ignore symbol — but ONLY when a written
 *    memory covers them. Unwritten messages are never hidden.
 *
 * Storage: settings in extensionSettings['cast_memory'],
 * per-chat data in chatMetadata['cast_memory'].
 */

const MODULE = 'cast_memory';
const LOG_PREFIX = '[CastMemory]';
const VERSION = '2.7.0';

function log(...args) { console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }

const cmErrors = [];
function noteError(where, e) {
    const msg = (e && e.message) ? e.message : String(e);
    cmErrors.push(`${where}: ${msg}`);
    warn(where, e);
    reportDiag();
}
function reportDiag() {
    const el = (typeof document !== 'undefined') ? document.getElementById('cm_diag') : null;
    if (!el) return;
    const fabEl = document.getElementById("cm-float");
    const wand = document.getElementById('cm-wand-entry') ? 'OK' : 'NG';
    let geo = '';
    try {
        if (fabEl) {
            const r = fabEl.getBoundingClientRect();
            const cs = getComputedStyle(fabEl);
            geo = ` | floatRect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
                + ` disp=${cs.display} vis=${cs.visibility} pos=${cs.position}`;
        }
        geo += ` | popup=${cmPopupOpen ? 'open' : 'closed'}`;
        geo += ` | win=${window.innerWidth}x${window.innerHeight}`;
    } catch { /* diag must never throw */ }
    el.textContent = `diag v${VERSION}: float=${fabEl ? 'OK' : 'NG'} sheet=${cmSheetEl ? 'OK' : 'NG'} wand=${wand}`
        + (cmErrors.length ? ` | errors: ${cmErrors.slice(-3).join(' ; ')}` : ' | errors: none')
        + geo;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Settings ────────────────────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    injectionMethod: 'interceptor', // 'interceptor' | 'extension'
    ghostVisuals: true,             // fade memory-covered messages in the chat UI
    keepTailMessages: 10,        // newest chat messages always kept raw
    sceneThresholdTokens: 6000,  // unwritten tokens that force a mid-scene write
    sceneTurnLimit: 6,           // unwritten assistant turns that force a write
    memoryBudgetTokens: 3000,    // max tokens of injected memory sections
    foldCharThreshold: 4000,     // per-character memory chars before folding
    summarizerResponseLength: 3000,
    connectionSource: 'profile', // 'default' | 'profile' | 'openai' | 'ollama'
    profileId: '',
    consultProfileId: '', // Connection Manager profile for the consult window (enables streaming)
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    writerSystemPrompt:
        'You are the memory keeper for a fictional roleplay. You read a scene and write memory records as strict JSON. Output ONLY the JSON object — no preamble, no commentary, no code fences.',
    writerUserPrompt:
        `<scene>
{{story_txt}}
</scene>

<participants>
{{participants}}
</participants>

<world_memory_so_far>
{{world_so_far}}
</world_memory_so_far>

Write the memory records for this scene as JSON with exactly this shape:
{"world": "...", "memories": {"<participant name>": "...", ...}}

Rules:
- "world": objective, shared facts only — what happened, where, when; decisions and promises anyone present could know; changes to places, items or ongoing situations; unresolved threads. Short markdown lines, no dialogue quotes. If nothing world-level changed, use "".
- "memories": one entry per participant listed above, keyed by their name copied character-for-character from the participants list — do not add readings, spaces, honorifics or surnames that are not in the listed name. Write what THAT character personally experienced: what they saw, heard, were told, felt, decided, misunderstood, or are now suspicious / hopeful / afraid about. Subjective, first-person viewpoint ("I ...") in brief markdown lines. A character can only remember things they were present for — never give them knowledge from outside this scene. If a participant was present but nothing notable happened to them, use "".
- Keep every entry tight: only what would change how that character acts later. No atmosphere, no prose retelling.`,
    foldSystemPrompt:
        'You condense long-term memory records. Output only the condensed memory text — no preamble, no commentary.',
    foldUserPrompt:
        `<memory_to_condense>
{{memory_txt}}
</memory_to_condense>

Condense this into a shorter long-term memory. Preserve: relationship changes (feelings, trust, suspicion stages), promises and agreements, important decisions, secrets the character holds, lasting changes and unresolved threads involving them. Drop scene-level detail and anything already resolved. Keep the same viewpoint as the original. Output markdown lines only.`,
    worldFoldUserPrompt:
        `<memory_to_condense>
{{memory_txt}}
</memory_to_condense>

Condense this world memory into a shorter long-term record. Preserve: the current state of places and situations, key past events still affecting the present, promises and agreements, and unresolved threads. Drop detail that no longer matters. Output markdown lines only.`,
    iconLeft: null,
    iconTop: null,
    locIconLeft: null,
    locIconTop: null,
    consultBtnLeft: null,
    consultBtnTop: null,
    consultPanelLeft: null,
    consultPanelTop: null,
});

function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE]) {
        ctx.extensionSettings[MODULE] = { ...defaultSettings };
    }
    const s = ctx.extensionSettings[MODULE];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function saveSettings() {
    try { SillyTavern.getContext().saveSettingsDebounced(); } catch (e) { /* noop */ }
}

// ─── Per-chat store ──────────────────────────────────────────────────────────
// store = {
//   version: 1,
//   characters: { [name]: { profile, memories: [{id,text,start,end,ts}],
//                           longTerm, present, created, updated } },
//   worldSetting: '',              // static world info from world blocks
//   worldEntries: [{id,text,start,end,ts}],
//   worldLongTerm: '',
//   presence: [{index, name, action}],   // login/logout transitions
//   parsedUpTo: -1,    // chat index; blocks parsed (and stripped) up to here
//   writtenUpTo: -1,   // chat index covered by memory writing
//   appliedUpTo: -1,   // chat index hidden via ignore flag (<= writtenUpTo)
// }

function emptyStore() {
    return {
        version: 1,
        characters: {},
        worldSetting: '',
        worldEntries: [],
        worldLongTerm: '',
        presence: [],
        parsedUpTo: -1,
        writtenUpTo: -1,
        appliedUpTo: -1,
        lastWrite: null,
        locations: {},
        currentLocation: '',
        consult: [],            // side-window conversation {role, text, ts}
        pendingInstruction: '', // one-shot GM instruction for the next main generation
    };
}

function getStore() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) return null;
    if (!ctx.chatMetadata[MODULE]) {
        ctx.chatMetadata[MODULE] = emptyStore();
    }
    const store = ctx.chatMetadata[MODULE];
    // Defensive shape repair (older/partial data).
    if (!store.characters || typeof store.characters !== 'object') store.characters = {};
    if (typeof store.worldSetting !== 'string') store.worldSetting = '';
    if (!Array.isArray(store.worldEntries)) store.worldEntries = [];
    if (store.lastWrite === undefined) store.lastWrite = null;
    if (!store.locations || typeof store.locations !== 'object') store.locations = {};
    if (typeof store.currentLocation !== 'string') store.currentLocation = '';
    if (!Array.isArray(store.consult)) store.consult = [];
    if (typeof store.pendingInstruction !== 'string') store.pendingInstruction = '';
    for (const loc of Object.values(store.locations)) {
        if (typeof loc.detail !== 'string') loc.detail = '';
    }
    if (typeof store.worldLongTerm !== 'string') store.worldLongTerm = '';
    if (!Array.isArray(store.presence)) store.presence = [];
    for (const k of ['parsedUpTo', 'writtenUpTo', 'appliedUpTo']) {
        if (!Number.isInteger(store[k])) store[k] = -1;
    }
    if (store.appliedUpTo > store.writtenUpTo) store.appliedUpTo = store.writtenUpTo;
    for (const ch of Object.values(store.characters)) {
        if (!Array.isArray(ch.memories)) ch.memories = [];
        if (typeof ch.profile !== 'string') ch.profile = '';
        if (typeof ch.longTerm !== 'string') ch.longTerm = '';
        ch.present = !!ch.present;
    }
    return store;
}

let _saveStoreTimer = null;
function saveStore() {
    clearTimeout(_saveStoreTimer);
    _saveStoreTimer = setTimeout(() => {
        try { SillyTavern.getContext().saveChat(); } catch (e) { /* noop */ }
    }, 400);
}

function getCharacter(store, name) {
    if (!store.characters[name]) {
        store.characters[name] = {
            profile: '', memories: [], longTerm: '',
            present: false, created: Date.now(), updated: Date.now(),
        };
    }
    return store.characters[name];
}

function matchLocationName(store, key, allowContains = true) {
    if (!key || !store || !store.locations) return null;
    if (store.locations[key]) return key;
    const nk = normalizeName(key);
    if (!nk) return null;
    const names = locationNames(store);
    for (const n of names) {
        if (normalizeName(n) === nk) return n;
    }
    if (!allowContains) return null;
    const contains = names.filter(n => {
        const nn = normalizeName(n);
        return nn && (nk.includes(nn) || nn.includes(nk));
    });
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
        contains.sort((a, b) => normalizeName(b).length - normalizeName(a).length);
        return contains[0];
    }
    return null;
}

function getLocation(store, name) {
    if (!store.locations[name]) {
        store.locations[name] = { detail: '', created: Date.now(), updated: Date.now() };
    }
    return store.locations[name];
}

function locationNames(store) {
    return Object.keys(store.locations || {});
}

function characterNames(store) {
    return Object.keys(store.characters);
}

function presentNames(store) {
    return characterNames(store).filter(n => store.characters[n].present);
}

// ─── Block parsing (pure) ────────────────────────────────────────────────────
// Blocks the main model emits inside its replies (HTML comments):
//   <!-- castmemory: login Name -->  /  <!-- castmemory: logout Name -->
//   <!-- castmemory character start
//   Name: X
//   ...profile markdown...
//   castmemory character end -->
//   <!-- castmemory world start
//   ...world info markdown...
//   castmemory world end -->

const LOGIN_RE = /<!--\s*castmemory:\s*login\s+([^>]+?)\s*-->/gi;
const LOGOUT_RE = /<!--\s*castmemory:\s*logout\s+([^>]+?)\s*-->/gi;
const RENAME_RE = /<!--\s*castmemory:\s*rename\s+(.+?)\s*(?:->|→|=>)\s*(.+?)\s*-->/gi;
const HERE_RE = /<!--\s*castmemory:\s*here\s+([^>]+?)\s*-->/gi;
const LOCATION_BLOCK_RE = /<!--\s*castmemory\s+location\s+start\s*\n([\s\S]*?)\n\s*castmemory\s+location\s+end\s*-->/gi;
const CHAR_BLOCK_RE = /<!--\s*castmemory\s+character\s+start\s*\n([\s\S]*?)\n\s*castmemory\s+character\s+end\s*-->/gi;
const WORLD_BLOCK_RE = /<!--\s*castmemory\s+world\s+start\s*\n([\s\S]*?)\n\s*castmemory\s+world\s+end\s*-->/gi;

/**
 * Strip a format-placeholder wrapper a model may echo around a
 * profile / world body: "(profile in markdown: ...)" → "...". Pure.
 */
function unwrapBodyText(text) {
    let t = String(text || '').trim();
    const m = t.match(/^\(\s*(?:profile|world info)\s+in\s+markdown\s*:?\s*/i);
    if (m) {
        t = t.slice(m[0].length);
        if (t.endsWith(')')) t = t.slice(0, -1);
        t = t.trim();
    }
    return t;
}

/** Extract every castmemory block from a message text. Pure. */
function parseBlocks(text) {
    const found = [];
    if (!text) return found;
    let m;
    const collect = (re, make) => {
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            found.push({ at: m.index, ...make(m) });
        }
    };
    collect(LOGIN_RE, (mm) => ({ kind: 'login', name: mm[1].trim() }));
    collect(LOGOUT_RE, (mm) => ({ kind: 'logout', name: mm[1].trim() }));
    collect(RENAME_RE, (mm) => ({ kind: 'rename', name: mm[1].trim(), newName: mm[2].trim() }));
    collect(HERE_RE, (mm) => ({ kind: 'here', name: mm[1].trim() }));
    collect(LOCATION_BLOCK_RE, (mm) => {
        const body = mm[1].trim();
        const nameLine = body.split('\n').map(x => x.trim()).find(x => /^name\s*:/i.test(x));
        const name = nameLine ? nameLine.replace(/^name\s*:\s*/i, '').trim() : '';
        const detail = body.split('\n').filter(x => x !== nameLine).join('\n').trim();
        return { kind: 'location', name, detail: unwrapBodyText(detail || body) };
    });
    collect(CHAR_BLOCK_RE, (mm) => {
        const body = mm[1].trim();
        const nameLine = body.split('\n').map(x => x.trim()).find(x => /^name\s*:/i.test(x));
        const name = nameLine ? nameLine.replace(/^name\s*:\s*/i, '').trim() : '';
        const profile = body.split('\n').filter(x => x !== nameLine).join('\n').trim();
        return { kind: 'character', name, profile: unwrapBodyText(profile || body) };
    });
    collect(WORLD_BLOCK_RE, (mm) => ({ kind: 'world', text: unwrapBodyText(mm[1]) }));
    found.sort((a, b) => a.at - b.at);
    return found;
}

/** Remove every castmemory block from a message text. Pure. */
function stripBlocks(text) {
    if (!text) return text;
    return text
        .replace(LOGIN_RE, '')
        .replace(LOGOUT_RE, '')
        .replace(RENAME_RE, '')
        .replace(HERE_RE, '')
        .replace(LOCATION_BLOCK_RE, '')
        .replace(CHAR_BLOCK_RE, '')
        .replace(WORLD_BLOCK_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Apply one parsed block to the store at chat position `index`.
 * Returns true when the store changed.
 */
/**
 * Rename a character, carrying over profile, memories, long-term
 * memory and presence history. If the new name is already registered,
 * the two records merge (memories combined in story order).
 * Pure store operation.
 */
function renameCharacter(store, oldName, newName) {
    if (!store || !oldName || !newName || oldName === newName) return false;
    const src = store.characters[oldName];
    if (!src) return false;
    const dst = store.characters[newName];
    if (dst) {
        dst.memories = [...dst.memories, ...src.memories].sort((a, b) => (a.start - b.start) || (a.ts - b.ts));
        dst.longTerm = [dst.longTerm, src.longTerm].filter(Boolean).join('\n');
        if (!dst.profile) dst.profile = src.profile;
        dst.present = dst.present || src.present;
        dst.created = Math.min(dst.created || Infinity, src.created || Infinity);
        dst.updated = Date.now();
    } else {
        store.characters[newName] = src;
    }
    delete store.characters[oldName];
    for (const p of store.presence) {
        if (p.name === oldName) p.name = newName;
    }
    return true;
}

function applyBlock(store, block, index) {
    if (!block || !block.kind) return false;
    switch (block.kind) {
        case 'login': {
            if (!block.name) return false;
            const ch = getCharacter(store, block.name);
            if (!ch.present) {
                ch.present = true;
                ch.updated = Date.now();
            }
            store.presence.push({ index, name: block.name, action: 'login' });
            return true;
        }
        case 'logout': {
            if (!block.name) return false;
            const ch = getCharacter(store, block.name);
            if (ch.present) {
                ch.present = false;
                ch.updated = Date.now();
            }
            store.presence.push({ index, name: block.name, action: 'logout' });
            return true;
        }
        case 'character': {
            if (!block.name) return false;
            const ch = getCharacter(store, block.name);
            ch.profile = block.profile || ch.profile;
            ch.updated = Date.now();
            // Being introduced means being on stage.
            if (!ch.present) {
                ch.present = true;
                store.presence.push({ index, name: block.name, action: 'login' });
            }
            return true;
        }
        case 'rename': {
            if (!block.name || !block.newName) return false;
            return renameCharacter(store, block.name, block.newName);
        }
        case 'location': {
            if (!block.name) return false;
            // Snap spelling variants (spaces, reading annotations) to
            // the registered place instead of duplicating it. No
            // containment matching here: creating "Guild 2F" must not
            // merge into "Guild".
            const target = matchLocationName(store, block.name, false) || block.name;
            const loc = getLocation(store, target);
            loc.detail = block.detail || loc.detail;
            loc.updated = Date.now();
            return true;
        }
        case 'here': {
            if (!block.name) return false;
            // "here" is a SELECTION from the list: snap near-miss
            // names (including containment) to the registered place;
            // only a genuine miss creates a new entry.
            const target = matchLocationName(store, block.name, true) || block.name;
            getLocation(store, target);
            store.currentLocation = target;
            return true;
        }
        case 'world': {
            if (!block.text) return false;
            store.worldSetting = store.worldSetting
                ? `${store.worldSetting}\n\n${block.text}`
                : block.text;
            return true;
        }
    }
    return false;
}

/**
 * Names present during chat range [start, end], from the presence log.
 * A character counts when a login at or before `end` is not closed by a
 * logout at or before `end`, and the interval intersects [start, end]. Pure.
 */
function participantsForRange(store, start, end) {
    const intervals = {}; // name -> [[from, to], ...] (to = Infinity while open)
    for (const p of store.presence) {
        if (!intervals[p.name]) intervals[p.name] = [];
        const list = intervals[p.name];
        if (p.action === 'login') {
            list.push([p.index, Infinity]);
        } else {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i][1] === Infinity) { list[i][1] = p.index; break; }
            }
        }
    }
    const names = [];
    for (const [name, list] of Object.entries(intervals)) {
        if (list.some(([a, b]) => a <= end && b >= start)) names.push(name);
    }
    return names;
}

/**
 * Resolve a sub-model memory key to a registered character name.
 * Sub models embellish names (added readings, spaces, full vs short
 * forms), so match in stages: exact → normalized exact → containment.
 * Pure.
 */
function normalizeName(s) {
    return String(s || '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/\s+/g, '')
        .trim();
}

function matchCharacterName(store, key) {
    if (!key || !store || !store.characters) return null;
    if (store.characters[key]) return key;
    const nk = normalizeName(key);
    if (!nk) return null;
    const names = characterNames(store);
    for (const n of names) {
        if (normalizeName(n) === nk) return n;
    }
    const contains = names.filter(n => {
        const nn = normalizeName(n);
        return nn && (nk.includes(nn) || nn.includes(nk));
    });
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
        contains.sort((a, b) => normalizeName(b).length - normalizeName(a).length);
        return contains[0];
    }
    return null;
}

/** Recompute present flags from the presence log (after edits/deletes). */
function recomputePresence(store) {
    for (const name of characterNames(store)) store.characters[name].present = false;
    const sorted = [...store.presence].sort((a, b) => a.index - b.index);
    for (const p of sorted) {
        const ch = store.characters[p.name];
        if (ch) ch.present = (p.action === 'login');
    }
}

// ─── Token counting ──────────────────────────────────────────────────────────
// Counts go through ST's own tokenizer service, but batched: ONE POST
// with every text as a {content} message returns the total (the server
// adds 3 tokens per message + 3 padding, which we strip back off).
// This replaces the old per-message getTokenCountAsync loop, whose
// many sequential POSTs could each fail and poison the whole count
// (and latch the extension into rough estimates for the session).
// On failure: one retry, then a length estimate for that call only,
// with a short cooldown before the server is tried again.

let lastTokenEstimate = -1;
let lastUnwrittenEstimate = -1;
let lastInjectedTokens = -1;
let tokenCountSource = 'server'; // 'server' | 'estimate'
let tokenFailUntil = 0;
let tokenCountInFlight = false;

function ignoreSymbol() {
    return SillyTavern.getContext().symbols.ignore;
}

function estimateByLength(texts) {
    return texts.reduce((a, t) => a + Math.ceil(String(t).length / 2), 0);
}

async function fetchTokenTotal(texts) {
    const ctx = SillyTavern.getContext();
    let model = '';
    try { model = ctx.getTokenizerModel() || ''; } catch (e) { /* default mapping */ }
    const headers = (() => {
        try { return ctx.getRequestHeaders(); } catch (e) { return { 'Content-Type': 'application/json' }; }
    })();
    const res = await fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(texts.map(t => ({ content: t }))),
    });
    if (!res.ok) throw new Error(`tokenizer service HTTP ${res.status}`);
    const data = await res.json();
    const raw = Number(data?.token_count);
    if (!Number.isFinite(raw)) throw new Error('tokenizer service returned no count');
    return Math.max(0, raw - 3 * texts.length - 3);
}

/** Total tokens for a list of texts (batched, resilient). */
async function countTextsTotal(texts) {
    const list = (texts || []).filter(t => typeof t === 'string' && t.length);
    if (!list.length) return 0;
    if (Date.now() < tokenFailUntil) {
        tokenCountSource = 'estimate';
        return estimateByLength(list);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const total = await fetchTokenTotal(list);
            tokenCountSource = 'server';
            return total;
        } catch (e) {
            if (attempt === 0) await sleep(400);
            else {
                tokenFailUntil = Date.now() + 30000;
                tokenCountSource = 'estimate';
                warn('batch token count failed; estimating for now:', e);
            }
        }
    }
    return estimateByLength(list);
}

async function estimateChatTokens() {
    if (tokenCountInFlight) return lastTokenEstimate;
    tokenCountInFlight = true;
    try {
        const { chat } = SillyTavern.getContext();
        const IGNORE = ignoreSymbol();
        const texts = [];
        for (const msg of chat) {
            if (!msg || !msg.mes || msg.is_system) continue;
            if (msg.extra?.[IGNORE]) continue;
            texts.push(msg.mes);
        }
        lastTokenEstimate = await countTextsTotal(texts);
        return lastTokenEstimate;
    } catch (e) {
        return lastTokenEstimate;
    } finally {
        tokenCountInFlight = false;
    }
}

const _textTokenCache = new Map();
async function estimateTextTokens(text) {
    if (!text) return 0;
    if (_textTokenCache.has(text)) return _textTokenCache.get(text);
    const tokens = await countTextsTotal([text]);
    _textTokenCache.set(text, tokens);
    return tokens;
}

/** Tokens of chat messages in (fromExclusive, toInclusive] not yet ignored. */
async function estimateRangeTokens(fromExclusive, toInclusive) {
    const { chat } = SillyTavern.getContext();
    const IGNORE = ignoreSymbol();
    const texts = [];
    for (let i = fromExclusive + 1; i <= toInclusive && i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || !msg.mes || msg.is_system) continue;
        if (msg.extra?.[IGNORE]) continue;
        texts.push(msg.mes);
    }
    return countTextsTotal(texts);
}

// ─── Sub-model calls ─────────────────────────────────────────────────────────

let lastWriterError = '';
let lastDroppedNote = '';

function extractText(res) {
    if (!res) return '';
    if (typeof res === 'string') return res;
    return res.content || res.text || res?.choices?.[0]?.message?.content || '';
}

async function callSubModelOnce(systemPrompt, userPrompt) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();

    switch (s.connectionSource) {
        case 'profile': {
            if (!s.profileId) throw new Error('接続プロファイルが未選択です（Cast Memory設定）');
            const svc = ctx.ConnectionManagerRequestService;
            if (!svc || typeof svc.sendRequest !== 'function') {
                throw new Error('ConnectionManagerRequestService is not available in this SillyTavern version');
            }
            const res = await svc.sendRequest(s.profileId, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ], { ignoreInstruct: true });
            return extractText(res);
        }
        case 'openai': {
            if (!s.openaiUrl || !s.openaiModel) throw new Error('OpenAI互換のURL / モデルが未設定です');
            const base = s.openaiUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
            const res = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(s.openaiKey ? { 'Authorization': `Bearer ${s.openaiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: s.openaiModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    max_tokens: s.summarizerResponseLength || undefined,
                    stream: false,
                }),
            });
            if (!res.ok) throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}`);
            const data = await res.json();
            return data?.choices?.[0]?.message?.content || '';
        }
        case 'ollama': {
            if (!s.ollamaModel) throw new Error('Ollamaモデルが未設定です');
            const base = (s.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
            const res = await fetch(`${base}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: s.ollamaModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                }),
            });
            if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
            const data = await res.json();
            return data?.message?.content || '';
        }
        default: {
            if (typeof ctx.generateRaw !== 'function') throw new Error('generateRaw is not available');
            const res = await ctx.generateRaw({
                prompt: userPrompt,
                systemPrompt: systemPrompt,
                responseLength: s.summarizerResponseLength || undefined,
            });
            return extractText(res);
        }
    }
}

/** Strip thinking blocks and code fences from a sub-model reply. */
function cleanModelText(raw) {
    if (!raw) return '';
    let t = String(raw);
    t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    return t.trim();
}

async function callSubModel(systemPrompt, userPrompt) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await callSubModelOnce(systemPrompt, userPrompt);
            const text = cleanModelText(raw);
            if (text) { lastWriterError = ''; return text; }
            lastWriterError = 'サブモデルが空の応答を返しました';
        } catch (e) {
            lastWriterError = String(e?.message || e);
            warn('sub-model attempt failed:', e);
        }
        if (attempt === 0) await sleep(1500);
    }
    return '';
}

/**
 * Extract the memory-writing JSON from a sub-model reply.
 * Returns { world: string, memories: {name: string} } or null. Pure.
 */
/** All top-level balanced {...} spans in a text (string-aware). Pure. */
function extractJsonCandidates(t) {
    const spans = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') { if (depth === 0) start = i; depth++; }
        else if (c === '}') {
            depth--;
            if (depth === 0 && start >= 0) { spans.push(t.slice(start, i + 1)); start = -1; }
            if (depth < 0) depth = 0;
        }
    }
    return spans;
}

/** Escape raw control characters sitting inside JSON string literals. Pure. */
function repairJsonStrings(t) {
    let out = '', inStr = false, esc = false;
    for (const c of t) {
        if (inStr) {
            if (esc) { out += c; esc = false; continue; }
            if (c === '\\') { out += c; esc = true; continue; }
            if (c === '"') { out += c; inStr = false; continue; }
            if (c === '\n') { out += '\\n'; continue; }
            if (c === '\r') { out += '\\r'; continue; }
            if (c === '\t') { out += '\\t'; continue; }
            out += c; continue;
        }
        if (c === '"') inStr = true;
        out += c;
    }
    return out;
}

/**
 * Parse the writer's JSON. Real responses may wrap the payload in
 * reasoning prose that itself contains braces, or carry literal
 * newlines inside string values — try every complete object,
 * last first, with and without string repair.
 * Returns { world, memories } or null.
 */
function parseWriterOutput(raw) {
    if (!raw) return null;
    const t = cleanModelText(raw).replace(/```(?:json)?/gi, '');
    const candidates = extractJsonCandidates(t);
    for (let i = candidates.length - 1; i >= 0; i--) {
        for (const variant of [candidates[i], repairJsonStrings(candidates[i])]) {
            try {
                const obj = JSON.parse(variant);
                if (!obj || typeof obj !== 'object') continue;
                const world = typeof obj.world === 'string' ? obj.world.trim() : '';
                const memories = {};
                if (obj.memories && typeof obj.memories === 'object') {
                    for (const [k, v] of Object.entries(obj.memories)) {
                        if (typeof v === 'string' && v.trim()) memories[k] = v.trim();
                    }
                }
                if (!world && Object.keys(memories).length === 0) continue;
                return { world, memories };
            } catch { /* try the next candidate / variant */ }
        }
    }
    return null;
}

// ─── Passage building ────────────────────────────────────────────────────────

function playerName() {
    try { return SillyTavern.getContext().name1 || 'the player'; } catch (e) { return 'the player'; }
}

function buildPassage(start, end) {
    const { chat, name1, name2 } = SillyTavern.getContext();
    const parts = [];
    for (let i = start; i <= end && i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes || !m.mes.trim()) continue;
        const name = m.name || (m.is_user ? name1 : name2);
        parts.push(`${name}: ${m.mes.trim()}`);
    }
    let text = parts.join('\n');
    const MAX = 24000;
    if (text.length > MAX) text = text.slice(0, MAX);
    return text;
}

function lastAssistantIndex() {
    const { chat } = SillyTavern.getContext();
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && m.mes && m.mes.trim()) return i;
    }
    return -1;
}

function assistantCountInRange(start, end) {
    const { chat } = SillyTavern.getContext();
    let n = 0;
    for (let i = start; i <= end && i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && m.mes && m.mes.trim()) n++;
    }
    return n;
}

function worldSoFarText(store) {
    const parts = [];
    if (store.worldLongTerm) parts.push(store.worldLongTerm);
    for (const e of store.worldEntries) parts.push(e.text);
    let joined = parts.join('\n');
    const MAX = 5000;
    while (joined.length > MAX && parts.length > 1) {
        parts.shift();
        joined = parts.join('\n');
    }
    return joined;
}

// ─── Memory writing (scene close) ────────────────────────────────────────────

let isWorking = false;

/**
 * Write memories for one range. Participants come from the presence log;
 * when nobody was logged in, fall back to known characters named in the
 * passage; when still nobody, the scene goes to world memory only, so
 * nothing is ever lost. Advances writtenUpTo on success.
 */
async function writeMemoriesForRange(start, end) {
    const s = getSettings();
    const store = getStore();
    if (!store || end < start) return false;

    const passage = buildPassage(start, end);
    if (!passage.trim()) {
        store.writtenUpTo = end;
        saveStore();
        return true;
    }

    let participants = participantsForRange(store, start, end);
    if (participants.length === 0) {
        participants = characterNames(store).filter(n => passage.includes(n));
    }

    const userPrompt = s.writerUserPrompt
        .replaceAll('{{player_name}}', playerName())
        .replaceAll('{{participants}}', participants.length ? participants.join(', ') : '(no named participants — write world memory only, with an empty memories object)')
        .replaceAll('{{world_so_far}}', worldSoFarText(store) || '(none yet)')
        .replaceAll('{{story_txt}}', passage);

    const raw = await callSubModel(s.writerSystemPrompt, userPrompt);
    if (!raw) return false;

    const parsed = parseWriterOutput(raw);
    const ts = Date.now();
    if (parsed) {
        if (parsed.world) {
            store.worldEntries.push({ id: newId(), text: parsed.world, start, end, ts });
        }
        const dropped = [];
        for (const [name, text] of Object.entries(parsed.memories)) {
            const matched = matchCharacterName(store, name);
            if (!matched) { dropped.push(name); continue; } // never invent characters
            const ch = store.characters[matched];
            ch.memories.push({ id: newId(), text, start, end, ts });
            ch.updated = ts;
        }
        if (dropped.length) {
            lastDroppedNote = `名前が一致せず割り当てられなかった記憶: ${dropped.join(', ')}`;
            warn(lastDroppedNote);
        } else {
            lastDroppedNote = '';
        }
        // Participants the sub model skipped still need coverage proof:
        // the range counts as written (world entry or not) — the write
        // itself is the coverage. Nothing is hidden without this step.
    } else {
        // Degraded fallback: keep the whole reply as a world entry so the
        // range is covered and no information is lost.
        const text = cleanModelText(raw).replace(/```[a-z]*/gi, '').trim();
        if (!text) return false;
        store.worldEntries.push({ id: newId(), text, start, end, ts });
        warn('writer output was not JSON; stored as world memory');
    }

    store.writtenUpTo = end;
    store.lastWrite = { start, end };
    saveStore();
    log(`Wrote memories for [${start}–${end}] participants=[${participants.join(', ')}]`);
    return true;
}

/**
 * Undo the most recent memory write: drop the entries it produced,
 * rewind writtenUpTo, un-hide anything past the new frontier, then
 * re-run the write. Used to recover from a degraded write (e.g. the
 * sub model's JSON failed to parse and landed in world memory raw).
 * Entries already folded into long-term memory are not restored.
 */
async function rewindLastWrite() {
    const store = getStore();
    if (!store || !store.lastWrite) return false;
    const { start } = store.lastWrite;
    store.worldEntries = store.worldEntries.filter(e => e.start !== start);
    for (const ch of Object.values(store.characters)) {
        ch.memories = ch.memories.filter(m => m.start !== start);
    }
    store.writtenUpTo = start - 1;
    if (store.appliedUpTo > store.writtenUpTo) {
        store.appliedUpTo = store.writtenUpTo;
        unmarkAllMessages();
        markAppliedMessages();
    }
    store.lastWrite = null;
    saveStore();
    log(`Rewound last write (range started at ${start}); rewriting`);
    return await maybeWriteScene(true);
}

/**
 * Decide whether to close the current scene and write its memories.
 * Auto-close when: everyone is logged out and at least 2 assistant
 * messages are unwritten, or unwritten tokens pass the threshold.
 */
async function maybeWriteScene(manual = false) {
    const s = getSettings();
    const store = getStore();
    if (!store || isWorking) return false;
    const end = lastAssistantIndex();
    if (end <= store.writtenUpTo) return false;
    const start = store.writtenUpTo + 1;

    lastUnwrittenEstimate = await estimateRangeTokens(store.writtenUpTo, end);
    const nobodyPresent = presentNames(store).length === 0;
    const enoughTurns = assistantCountInRange(start, end) >= 2;
    const overThreshold = lastUnwrittenEstimate >= s.sceneThresholdTokens;
    // Continuous scenes with a stable cast may never see a logout; a turn
    // limit guarantees memories still form at a steady cadence.
    const turnLimitHit = s.sceneTurnLimit > 0 && assistantCountInRange(start, end) >= s.sceneTurnLimit;
    if (!manual && !((nobodyPresent && enoughTurns) || overThreshold || turnLimitHit)) return false;

    isWorking = true;
    updateFloat();
    try {
        const ok = await writeMemoriesForRange(start, end);
        if (ok) {
            advanceApplied();
            await maybeFold();
        }
        return ok;
    } finally {
        isWorking = false;
        updateUI();
    }
}

// ─── Apply (ignore flags) ────────────────────────────────────────────────────
// Invariant: appliedUpTo never passes writtenUpTo, and always lands on a
// memory-entry boundary, so every hidden message is covered by an entry
// that will be injected.

function entryBoundaries(store) {
    const ends = new Set();
    for (const e of store.worldEntries) ends.add(e.end);
    for (const ch of Object.values(store.characters)) {
        for (const m of ch.memories) ends.add(m.end);
    }
    return [...ends].sort((a, b) => a - b);
}

function advanceApplied() {
    const s = getSettings();
    const store = getStore();
    if (!store) return;
    const { chat } = SillyTavern.getContext();
    if (!chat) return;
    const candidate = Math.min(store.writtenUpTo, chat.length - 1 - s.keepTailMessages);
    if (candidate <= store.appliedUpTo) return;
    let target = store.appliedUpTo;
    for (const end of entryBoundaries(store)) {
        if (end <= candidate && end > target) target = end;
    }
    // Ranges written before any character/world entry existed (empty
    // passages) have no entries; writtenUpTo itself is a safe boundary.
    if (target === store.appliedUpTo && candidate === store.writtenUpTo) {
        target = candidate;
    }
    if (target > store.appliedUpTo) {
        store.appliedUpTo = target;
        markAppliedMessages();
        saveStore();
        log(`Applied: history hidden up to message ${target}`);
    }
}

function markAppliedMessages() {
    const store = getStore();
    if (!store || store.appliedUpTo < 0) return;
    try {
        const { chat } = SillyTavern.getContext();
        const IGNORE = ignoreSymbol();
        for (let i = 0; i <= store.appliedUpTo && i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            if (!m.extra) m.extra = {};
            m.extra[IGNORE] = true;
        }
    } catch (e) {
        warn('markAppliedMessages error:', e);
    }
}

function unmarkAllMessages() {
    try {
        const { chat } = SillyTavern.getContext();
        const IGNORE = ignoreSymbol();
        for (const m of chat) {
            if (m?.extra && m.extra[IGNORE]) delete m.extra[IGNORE];
        }
    } catch (e) { /* noop */ }
}

/** Undo the hiding only (memories stay; originals are sent again). */
function unapplyAll() {
    const store = getStore();
    if (!store) return;
    store.appliedUpTo = -1;
    unmarkAllMessages();
    saveStore();
}

/**
 * The furthest index that may be ghosted in one go: the largest
 * memory-entry boundary not past writtenUpTo (never a partial entry,
 * never anything unwritten). Pure.
 */
function ghostTarget(store) {
    if (!store || store.writtenUpTo < 0) return -1;
    let target = -1;
    for (const end of entryBoundaries(store)) {
        if (end <= store.writtenUpTo && end > target) target = end;
    }
    // Ranges written with no entries at all (empty passages) are safe.
    return target >= 0 ? target : store.writtenUpTo;
}

/**
 * Ghost everything already written, ignoring the keep-tail rule —
 * the manual override for the current chat. Reversible via unapply.
 */
function ghostAllNow() {
    const store = getStore();
    if (!store) return -1;
    const target = ghostTarget(store);
    if (target <= store.appliedUpTo) return store.appliedUpTo;
    store.appliedUpTo = target;
    markAppliedMessages();
    saveStore();
    applyGhostStyles();
    return target;
}

/**
 * Visual ghosting: messages covered by memories (index <= appliedUpTo)
 * are faded in the chat UI and get a ghost marker. The messages stay
 * fully readable — only their prompt presence is gone (ignore flag).
 */
function applyGhostStyles() {
    try {
        const s = getSettings();
        const store = getStore();
        const active = !!(s.enabled && s.ghostVisuals && store && store.appliedUpTo >= 0);
        const els = document.querySelectorAll('#chat .mes');
        els.forEach(el => {
            const id = Number(el.getAttribute('mesid'));
            const on = active && Number.isInteger(id) && id <= store.appliedUpTo;
            el.classList.toggle('cm-ghost', on);
        });
    } catch (e) { /* DOM is best-effort */ }
}

// ─── Folding (long-term compression) ─────────────────────────────────────────

async function foldCharacter(name) {
    const s = getSettings();
    const store = getStore();
    const ch = store?.characters[name];
    if (!ch || ch.memories.length < 2) return false;
    const totalChars = ch.memories.reduce((a, m) => a + m.text.length, 0) + ch.longTerm.length;
    if (totalChars <= s.foldCharThreshold) return false;
    // Keep the 2 newest entries raw; fold the rest into longTerm.
    const keep = ch.memories.slice(-2);
    const fold = ch.memories.slice(0, -2);
    if (fold.length === 0) return false;
    const joined = (ch.longTerm ? ch.longTerm + '\n' : '') + fold.map(m => m.text).join('\n');
    const userPrompt = s.foldUserPrompt.replaceAll('{{memory_txt}}', joined);
    const out = await callSubModel(s.foldSystemPrompt, userPrompt);
    if (!out) return false;
    ch.longTerm = cleanModelText(out).replace(/```[a-z]*/gi, '').trim();
    ch.memories = keep;
    ch.updated = Date.now();
    saveStore();
    log(`Folded memories of ${name} (${fold.length} entries → long-term)`);
    return true;
}

async function foldWorld() {
    const s = getSettings();
    const store = getStore();
    if (!store || store.worldEntries.length < 2) return false;
    const totalChars = store.worldEntries.reduce((a, e) => a + e.text.length, 0) + store.worldLongTerm.length;
    if (totalChars <= s.foldCharThreshold) return false;
    const keep = store.worldEntries.slice(-2);
    const fold = store.worldEntries.slice(0, -2);
    if (fold.length === 0) return false;
    const joined = (store.worldLongTerm ? store.worldLongTerm + '\n' : '') + fold.map(e => e.text).join('\n');
    const userPrompt = s.worldFoldUserPrompt.replaceAll('{{memory_txt}}', joined);
    const out = await callSubModel(s.foldSystemPrompt, userPrompt);
    if (!out) return false;
    store.worldLongTerm = cleanModelText(out).replace(/```[a-z]*/gi, '').trim();
    store.worldEntries = keep;
    saveStore();
    log(`Folded world memory (${fold.length} entries → long-term)`);
    return true;
}

/** At most one fold per entity per cycle, to bound latency. */
async function maybeFold() {
    for (const name of characterNames(getStore() || emptyStore())) {
        await foldCharacter(name);
    }
    await foldWorld();
}

// ─── Block processing driver ─────────────────────────────────────────────────

/**
 * Scan chat messages after parsedUpTo, apply their blocks and strip the
 * block text from the messages. Runs on chat load and on new messages,
 * so blocks emitted while the extension was off are still caught.
 */
function processNewBlocks() {
    const store = getStore();
    if (!store) return false;
    const { chat } = SillyTavern.getContext();
    if (!chat) return false;
    let changed = false;
    for (let i = store.parsedUpTo + 1; i < chat.length; i++) {
        const m = chat[i];
        store.parsedUpTo = i;
        if (!m || m.is_user || m.is_system || !m.mes) continue;
        const blocks = parseBlocks(m.mes);
        if (blocks.length === 0) continue;
        for (const b of blocks) {
            if (applyBlock(store, b, i)) changed = true;
        }
        const stripped = stripBlocks(m.mes);
        if (stripped !== m.mes) {
            m.mes = stripped;
        }
        changed = true;
    }
    if (changed) saveStore();
    // No re-render needed: the blocks are HTML comments, invisible in the
    // chat display. Stripping matters for the prompt (tokens) and storage,
    // both handled by the save above.
    return changed;
}

// ─── Injection ───────────────────────────────────────────────────────────────

function profileOneLiner(profile) {
    if (!profile) return '';
    const line = profile.split('\n').map(x => x.trim()).find(x => x && !x.startsWith('#'));
    return line ? line.slice(0, 80) : '';
}

/**
 * Assemble the <cast_memory> block. Pure given a token estimator.
 * Sections: world (setting + applied world memory), on-stage characters
 * (profile always; memories only for entries covering hidden history),
 * and the roster (always, so the main model can self-correct presence).
 */
async function assembleBlock(store, budgetTokens) {
    if (!store) return '';
    const sections = [];

    // Roster — always present, cheap, and the model's presence reference.
    const names = characterNames(store);
    if (names.length) {
        const roster = names.map(n => {
            const ch = store.characters[n];
            const one = profileOneLiner(ch.profile);
            return `- ${n} — ${ch.present ? 'ON STAGE' : 'off stage'}${one ? ` — ${one}` : ''}`;
        }).join('\n');
        sections.push({ key: 'roster', text: `## Cast roster\n${roster}`, priority: 0 });
    }

    // World setting from blocks — static reference, always included.
    if (store.worldSetting) {
        sections.push({ key: 'worldSetting', text: `## World\n${store.worldSetting}`, priority: 1 });
    }

    // Locations: the full list is cheap (one line each, always in);
    // only the CURRENT location's detail is injected in full, so the
    // location data in the prompt stays bounded no matter how many
    // places the story visits.
    const locNames = locationNames(store);
    if (locNames.length) {
        const list = locNames.map(n => {
            const loc = store.locations[n];
            const one = profileOneLiner(loc.detail);
            const marker = n === store.currentLocation ? '📍 ' : '';
            return `- ${marker}${n}${one ? ` — ${one}` : ''}`;
        }).join('\n');
        sections.push({ key: 'locations', text: `## Locations\n${list}`, priority: 1 });
        const cur = store.currentLocation ? store.locations[store.currentLocation] : null;
        if (cur && cur.detail) {
            sections.push({ key: 'currentLocation', text: `## Current location: ${store.currentLocation}\n${cur.detail}`, priority: 1 });
        }
    }

    // World memory covering hidden history only.
    const worldMem = [];
    if (store.worldLongTerm) worldMem.push(store.worldLongTerm);
    for (const e of store.worldEntries) {
        if (e.end <= store.appliedUpTo) worldMem.push(e.text);
    }
    if (worldMem.length) {
        sections.push({ key: 'worldMemory', text: `## World memory (events so far)\n${worldMem.join('\n')}`, priority: 2 });
    }

    // On-stage characters: profile + their own memories of hidden history.
    for (const name of presentNames(store)) {
        const ch = store.characters[name];
        const parts = [`### ${name}`];
        if (ch.profile) parts.push(ch.profile);
        const mems = [];
        if (ch.longTerm) mems.push(ch.longTerm);
        for (const m of ch.memories) {
            if (m.end <= store.appliedUpTo) mems.push(m.text);
        }
        if (mems.length) parts.push(`What ${name} remembers:\n${mems.join('\n')}`);
        sections.push({ key: `char:${name}`, text: parts.join('\n'), priority: 3 });
    }

    // Off-stage characters keep only long-term memory in the prompt when
    // budget allows — they are not acting now, but their past still colors
    // the world. (Their recent memories return when they log back in.)
    for (const name of names) {
        const ch = store.characters[name];
        if (ch.present) continue;
        if (!ch.longTerm) continue;
        sections.push({ key: `offstage:${name}`, text: `### ${name} (off stage)\n${ch.longTerm}`, priority: 4 });
    }

    if (sections.length === 0) return '';

    sections.sort((a, b) => a.priority - b.priority);
    const header = '<cast_memory>\n[Maintained records. Each character knows ONLY what is in their own memory below — never let a character act on events they did not witness. The roster shows who is on stage right now. EVERY reply: declare the current place first with a castmemory "here" block, copying the name exactly from the Locations list; if the place is not listed, create it with a location block in the same reply.]';
    let out = header;
    let used = await estimateTextTokens(header);
    for (const sec of sections) {
        const t = await estimateTextTokens(sec.text);
        if (sec.priority <= 1) {
            // Roster and world setting are structural: always include.
            out += `\n\n${sec.text}`;
            used += t;
            continue;
        }
        if (used + t > budgetTokens && out !== header) {
            // Try a truncated version for character sections before skipping.
            if (sec.key.startsWith('char:') && used < budgetTokens) {
                const room = Math.max(0, (budgetTokens - used) * 2); // ~2 chars/token
                if (room > 200) out += `\n\n${sec.text.slice(0, room)}`;
            }
            continue;
        }
        out += `\n\n${sec.text}`;
        used += t;
    }
    if (out === header) return '';
    return out + '\n</cast_memory>';
}

let lastGen = { at: 0, included: false, type: '' };
let lastInjected = { at: 0, text: '' };
let lastRegisteredBlock = null; // last text pushed via setExtensionPrompt

/**
 * Extension-prompt injection mode: register the assembled block with
 * ST's prompt system so it appears in the prompt preview / raw prompt.
 * Registrations are wiped by ST on every chat switch (clearChat), so
 * this is re-run after chat changes, store updates and UI refreshes;
 * the change guard keeps it to one call per actual content change.
 */
async function refreshExtensionPrompt() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setExtensionPrompt !== 'function') return;
        const s = getSettings();
        // extension_prompt_types.IN_PROMPT = 0, extension_prompt_roles.SYSTEM = 0
        if (!s.enabled || s.injectionMethod !== 'extension') {
            if (lastRegisteredBlock !== '' && lastRegisteredBlock !== null) {
                ctx.setExtensionPrompt('cast_memory', '', 0, 0, false, 0);
                lastRegisteredBlock = '';
            }
            return;
        }
        const store = getStore();
        if (!store) return;
        const block = await assembleBlock(store, s.memoryBudgetTokens + 800);
        if (block === lastRegisteredBlock) return;
        ctx.setExtensionPrompt('cast_memory', block, 0, 0, false, 0);
        lastRegisteredBlock = block;
        if (block) {
            lastInjected = { at: Date.now(), text: block };
            lastGen = { at: Date.now(), included: true, type: 'extension' };
            estimateTextTokens(block).then(v => { lastInjectedTokens = v; }).catch(() => {});
        }
    } catch (e) {
        warn('refreshExtensionPrompt error:', e);
    }
}

globalThis.castMemoryInterceptor = async function (chatArray, _contextSize, _abort, type) {
    try {
        lastGen = { at: Date.now(), included: false, type: String(type || '') };
        const s = getSettings();
        if (!s.enabled) return;
        if (type === 'quiet' || type === 'impersonate') return;
        const store = getStore();
        if (!store) return;
        // One-shot GM instruction armed from the consult window: rides
        // on this generation only, appended at the very end of the
        // prompt, and never becomes a chat message.
        if (store.pendingInstruction) {
            const text = store.pendingInstruction;
            store.pendingInstruction = '';
            saveStore();
            chatArray.push({
                name: 'GM instruction',
                is_user: false,
                is_system: true,
                send_date: Date.now(),
                mes: `[GM instruction — applies to this reply only]\n${text}`,
                extra: { type: 'narrator' },
            });
            setTimeout(updateUI, 50);
        }
        if (s.injectionMethod === 'extension') {
            // The block rides as a registered extension prompt instead.
            lastGen.included = !!lastRegisteredBlock;
            return;
        }
        const block = await assembleBlock(store, s.memoryBudgetTokens + 800); // +800: roster/setting headroom
        if (!block) return;
        lastInjected = { at: Date.now(), text: block };
        estimateTextTokens(block).then(v => { lastInjectedTokens = v; }).catch(() => {});
        chatArray.splice(0, 0, {
            name: 'Cast Memory',
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: block,
            extra: { type: 'narrator' },
        });
        lastGen.included = true;
        setTimeout(updateUI, 50);
    } catch (e) {
        warn('interceptor error:', e);
    }
};

// ─── Background cycle + events ───────────────────────────────────────────────

async function backgroundCycle() {
    const s = getSettings();
    if (!s.enabled) { updateUI(); return; }
    try {
        processNewBlocks();
        await maybeWriteScene(false);
        await estimateChatTokens();
    } catch (e) {
        warn('background cycle error:', e);
    }
    updateUI();
}

function clampStoreToChat() {
    const store = getStore();
    const { chat } = SillyTavern.getContext();
    if (!store || !chat) return;
    const maxIdx = chat.length - 1;
    let changed = false;
    for (const k of ['parsedUpTo', 'writtenUpTo', 'appliedUpTo']) {
        if (store[k] > maxIdx) { store[k] = maxIdx; changed = true; }
    }
    store.presence = store.presence.filter(p => p.index <= maxIdx);
    for (const ch of Object.values(store.characters)) {
        const before = ch.memories.length;
        ch.memories = ch.memories.filter(m => m.start <= maxIdx);
        if (ch.memories.length !== before) changed = true;
    }
    const wb = store.worldEntries.length;
    store.worldEntries = store.worldEntries.filter(e => e.start <= maxIdx);
    if (store.worldEntries.length !== wb) changed = true;
    recomputePresence(store);
    if (changed) saveStore();
}

function onMessageReceived() {
    setTimeout(() => { backgroundCycle(); }, 350);
}

function onChatChanged() {
    setTimeout(async () => {
        lastInjected = { at: 0, text: '' };
        lastInjectedTokens = -1;
        lastRegisteredBlock = null; // ST wiped extension_prompts with the chat
        consultDraft = null; // a draft distilled in another chat must not leak over
        clampStoreToChat();
        processNewBlocks();
        markAppliedMessages(); // ignore flags don't survive a reload — re-assert
        await estimateChatTokens();
        updateUI();
    }, 150);
}

async function clearAllData() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) return;
    unmarkAllMessages();
    ctx.chatMetadata[MODULE] = emptyStore();
    saveStore();
    try { await ctx.saveChat(); } catch (e) { /* noop */ }
    updateUI();
    toastr.success('Cast Memory のデータを全て消去しました', 'Cast Memory');
}

// ─── UI: floating button + sheet ─────────────────────────────────────────────


let cmSheetEl = null;
let cmPopupOpen = false;
let cmTab = 'cast';           // 'cast' | 'world' | 'ops'
let cmSelectedChar = null;    // character name open in detail view
let cmSelectedLoc = null;     // location name open in detail view

function buildFabAndSheet() {
    buildSheetContent();
    buildFloatButton();
    buildLocChip();
    buildConsultButton();
    buildConsultPanel();
}

// The button float and the location float are separate elements, each
// with its own saved position, so they can be dragged independently.
// Position is anchored from the top with viewport units, never
// bottom/right: ST sets perspective/transform on <html>, making it
// the containing block for fixed elements; on the phone layout that
// block collapses and bottom-anchored elements render above the
// screen. Default spots are the top-left of the chat area.
function floatBaseStyle() {
    return 'position:fixed;z-index:2147483000;display:block;'
        + 'touch-action:none;user-select:none;-webkit-user-select:none;';
}

function buildFloatButton() {
    if (document.getElementById('cm-float')) return;
    const el = document.createElement('div');
    el.id = 'cm-float';
    el.title = 'Cast Memory';
    el.style.cssText = floatBaseStyle();
    el.innerHTML = `
        <button class="cm-fab" type="button" title="Cast Memory を開く">
            <span class="cm-fab-face">🎭</span>
            <span class="cm-fab-spinner" hidden></span>
            <span class="cm-fab-badge" hidden>0</span>
        </button>`;
    document.body.appendChild(el);
    applyFloatPosition(el, 'iconLeft', 'iconTop', 10, 54);
    bindFloatDrag(el, 'iconLeft', 'iconTop', () => openSheet());
}

function buildLocChip() {
    if (document.getElementById('cm-loc-float')) return;
    const el = document.createElement('div');
    el.id = 'cm-loc-float';
    el.style.cssText = floatBaseStyle();
    el.innerHTML = `
        <div class="cm-loc-chip" title="現在地（タップでワールドを開く）">
            <span class="cm-pin">📍</span>
            <span class="cm-loc-name">現在地未設定</span>
        </div>`;
    document.body.appendChild(el);
    applyFloatPosition(el, 'locIconLeft', 'locIconTop', 70, 65);
    bindFloatDrag(el, 'locIconLeft', 'locIconTop', () => {
        const store = getStore();
        if (store && store.currentLocation) cmSelectedLoc = store.currentLocation;
        openSheet('world');
    });
}

function applyFloatPosition(el, keyL, keyT, defL, defT) {
    if (!el) return;
    const s = getSettings();
    if (Number.isFinite(s[keyL]) && Number.isFinite(s[keyT])) {
        const w = el.offsetWidth || 60;
        const ok = s[keyL] > -w + 16 && s[keyL] < window.innerWidth - 16
            && s[keyT] >= 0 && s[keyT] < window.innerHeight - 16;
        if (ok) {
            el.style.left = `${s[keyL]}px`;
            el.style.top = `${s[keyT]}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            return;
        }
        delete s[keyL];
        delete s[keyT];
        saveSettings();
    }
    el.style.left = `${defL}px`;
    el.style.top = `${defT}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
}

function bindFloatDrag(el, keyL, keyT, onTap) {
    let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false, moved = false, captured = false;
    el.addEventListener('pointerdown', (e) => {
        const rect = el.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        origLeft = rect.left; origTop = rect.top;
        dragging = true; moved = false; captured = false;
    });
    el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (!moved) return;
        if (!captured) {
            try { el.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
            captured = true;
        }
        e.preventDefault();
        const w = el.offsetWidth, h = el.offsetHeight;
        const left = Math.min(Math.max(0, origLeft + dx), window.innerWidth - Math.min(w, window.innerWidth));
        const top = Math.min(Math.max(0, origTop + dy), window.innerHeight - 30);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    });
    el.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
            const rect = el.getBoundingClientRect();
            const s = getSettings();
            s[keyL] = Math.round(Math.min(Math.max(0, rect.left), window.innerWidth - 40));
            s[keyT] = Math.round(Math.min(Math.max(0, rect.top), window.innerHeight - 30));
            saveSettings();
            return;
        }
        onTap();
    });
}

// ─── Consult window (OOC side chat with the main model) ─────────────────────
// A small overlay window, separate from the story chat: the player can
// discuss the story's direction with the main model, have it fix Cast
// Memory data by emitting declaration blocks, and arm a reply as a
// one-shot GM instruction for the next main generation. Nothing here
// ever becomes a story message.

const CONSULT_SYSTEM_PROMPT = `[Cast Memory — consultation mode]
You are the same model that writes the main story, now talking out of character with the player in a side window. The story itself is NOT advancing here. A snapshot of the current story state (the cast memory block and the recent messages) follows in the next system message; treat it as ground truth about the story so far.

Rules:
- Reply in Japanese, in a relaxed out-of-character tone. Be concise and concrete.
- When the player asks for a story directive (what should happen next, how a character should act), state it as one clear, self-contained instruction that could be handed to the story as-is.
- When the player asks you to register or fix Cast Memory data (a character that was never added, a wrong current location, someone who should be on/off stage, a rename), output the declaration blocks below — exactly in these formats — in addition to a short confirmation in prose. The extension applies the blocks immediately. Never output blocks unless the player asked for a data change.
  - Enter stage: <!-- castmemory: login NAME -->
  - Leave stage: <!-- castmemory: logout NAME -->
  - Character profile: <!-- castmemory character start
    Name: NAME
    (profile in markdown: who they are, appearance, personality, relationship to the player character)
    castmemory character end -->
  - Location: <!-- castmemory location start
    Name: NAME
    (what the place is like)
    castmemory location end -->
  - Set current location: <!-- castmemory: here NAME -->
  - Rename: <!-- castmemory: rename OLD -> NEW -->
  - World setting (concept / premise only, never place details): <!-- castmemory world start
    (text)
    castmemory world end -->
- Write character profiles and location details from the story context provided. Use registered names exactly as they appear in the roster.
- Do not write story prose or roleplay replies here; that belongs to the main chat.`;

const CONSULT_DISTILL_PROMPT = `[Cast Memory — instruction distillation]
Read the consultation between the player and the GM below (a story-state snapshot may follow) and write ONE self-contained GM instruction for the next reply of the main story.

Rules:
- Include only what the story model needs: what should happen next, how each involved character should act and feel, facts decided during the consultation, and constraints (what must NOT happen).
- Reflect the final consensus, including corrections made along the way. Drop options that were considered and rejected.
- Write direct instructions to the story model, in Japanese, compactly (short paragraphs or bullets).
- Never mention the consultation, this window, or that anything was summarized. No preamble — output only the instruction text.`;

let consultBusy = false;
let consultMinimized = false;
let consultDraft = null;     // distilled instruction awaiting confirmation
let draftShownText = null;   // draft text currently rendered in the editor

function buildConsultButton() {
    if (document.getElementById('cm-consult-float')) return;
    const el = document.createElement('div');
    el.id = 'cm-consult-float';
    el.style.cssText = floatBaseStyle();
    el.innerHTML = `
        <button class="cm-fab cm-fab-sub" type="button" title="相談窓を開く">
            <span class="cm-fab-face">💬</span>
            <span class="cm-fab-badge cm-cb-badge" hidden>📌</span>
        </button>`;
    document.body.appendChild(el);
    applyFloatPosition(el, 'consultBtnLeft', 'consultBtnTop', 10, 116);
    bindFloatDrag(el, 'consultBtnLeft', 'consultBtnTop', () => toggleConsultPanel());
}

function buildConsultPanel() {
    if (document.getElementById('cm-consult-panel')) return;
    const el = document.createElement('div');
    el.id = 'cm-consult-panel';
    el.hidden = true;
    el.innerHTML = `
        <div class="cm-cp-head">
            <span class="cm-cp-title">💬 相談</span>
            <span class="cm-cp-btns">
                <button type="button" data-cp="clear" title="相談履歴を消去">🗑</button>
                <button type="button" data-cp="min" title="最小化">―</button>
                <button type="button" data-cp="close" title="閉じる">✕</button>
            </span>
        </div>
        <div class="cm-cp-body">
            <div class="cm-cp-banner" hidden>
                <span class="cm-cp-banner-text"></span>
                <button type="button" data-cp="unarmed">取消</button>
            </div>
            <div class="cm-cp-msgs"></div>
            <div class="cm-cp-actions" hidden>
                <button type="button" data-cp="distill">📝 話し合いを指示にまとめて本編へ</button>
            </div>
            <div class="cm-cp-draft" hidden></div>
            <div class="cm-cp-inputrow">
                <textarea class="cm-cp-input" rows="2" placeholder="展開の相談・指示・「〇〇を追加して」など"></textarea>
                <button type="button" class="cm-cp-send">送信</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    applyConsultPanelPosition(el);
    bindConsultPanelDrag(el);
    el.addEventListener('click', onConsultPanelClick);
    el.querySelector('.cm-cp-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendConsult();
        }
    });
}

function applyConsultPanelPosition(el) {
    const s = getSettings();
    const w = Math.min(window.innerWidth * 0.88, 360);
    let left = Number.isFinite(s.consultPanelLeft) ? s.consultPanelLeft : Math.max(6, window.innerWidth - w - 10);
    let top = Number.isFinite(s.consultPanelTop) ? s.consultPanelTop : 54;
    left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - 60));
    top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - 60));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

function bindConsultPanelDrag(el) {
    const head = el.querySelector('.cm-cp-head');
    let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false, moved = false, captured = false;
    head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const rect = el.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        origLeft = rect.left; origTop = rect.top;
        dragging = true; moved = false; captured = false;
    });
    head.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (!moved) return;
        if (!captured) {
            try { head.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
            captured = true;
        }
        e.preventDefault();
        const left = Math.min(Math.max(0, origLeft + dx), window.innerWidth - 60);
        const top = Math.min(Math.max(0, origTop + dy), window.innerHeight - 40);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    });
    head.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
            const rect = el.getBoundingClientRect();
            const s = getSettings();
            s.consultPanelLeft = Math.round(rect.left);
            s.consultPanelTop = Math.round(rect.top);
            saveSettings();
        }
    });
}

function toggleConsultPanel(force) {
    const el = document.getElementById('cm-consult-panel');
    if (!el) return;
    const show = typeof force === 'boolean' ? force : el.hidden;
    el.hidden = !show;
    if (show) renderConsult();
}

function describeBlock(block) {
    switch (block.kind) {
        case 'login': return `「${block.name}」を登場させました`;
        case 'logout': return `「${block.name}」を退場させました`;
        case 'character': return `キャラクター「${block.name}」を登録しました`;
        case 'location': return `場所「${block.name}」を登録しました`;
        case 'here': return `現在地を「${block.name}」にしました`;
        case 'rename': return `「${block.name}」を「${block.newName}」に改名しました`;
        case 'world': return 'ワールド情報を追加しました';
        default: return 'データを更新しました';
    }
}

function renderConsult() {
    const panel = document.getElementById('cm-consult-panel');
    if (!panel) return;
    const store = getStore();
    const msgs = panel.querySelector('.cm-cp-msgs');
    const banner = panel.querySelector('.cm-cp-banner');
    const s = getSettings();
    panel.style.opacity = s.enabled ? '1' : '0.5';

    if (banner && store) {
        const armed = !!store.pendingInstruction;
        banner.hidden = !armed;
        if (armed) {
            const t = banner.querySelector('.cm-cp-banner-text');
            const preview = store.pendingInstruction.length > 60
                ? `${store.pendingInstruction.slice(0, 60)}…`
                : store.pendingInstruction;
            if (t) t.textContent = `📌 次の本編に反映：${preview}`;
        }
    }
    const badge = document.querySelector('.cm-cb-badge');
    if (badge) badge.hidden = !(store && store.pendingInstruction);

    if (!msgs) return;
    const prevTop = msgs.scrollTop;
    const wasAtBottom = msgs.scrollHeight - prevTop - msgs.clientHeight < 60;
    if (!store || store.consult.length === 0) {
        msgs.innerHTML = '<div class="cm-cp-empty">展開の相談、本編への指示、キャラクター追加漏れの修正などをここで話せます。本編の履歴には混ざりません。</div>';
        return;
    }
    msgs.innerHTML = store.consult.map((m, i) => {
        if (m.role === 'note') {
            return `<div class="cm-cp-note">${escapeHtml(m.text)}</div>`;
        }
        if (m.role === 'user') {
            return `<div class="cm-cp-msg cm-cp-user"><div class="cm-cp-bubble">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div></div>`;
        }
        return `<div class="cm-cp-msg cm-cp-assistant"><div class="cm-cp-bubble cm-md mes_text">${renderMd(m.text, '')}</div></div>`;
    }).join('');
    msgs.scrollTop = wasAtBottom ? msgs.scrollHeight : prevTop;

    // "Distill into an instruction" action: available once there is
    // an actual exchange to summarize.
    const actions = panel.querySelector('.cm-cp-actions');
    if (actions && store) {
        const hasExchange = store.consult.some(m => m.role === 'user')
            && store.consult.some(m => m.role === 'assistant');
        actions.hidden = !hasExchange || consultDraft !== null;
    }
    // Draft editor: rendered once per distilled text so re-renders
    // (background updateUI) never clobber the user's edits.
    const draftEl = panel.querySelector('.cm-cp-draft');
    if (draftEl) {
        if (consultDraft === null) {
            draftEl.hidden = true;
            draftEl.innerHTML = '';
            draftShownText = null;
        } else if (draftShownText !== consultDraft) {
            draftShownText = consultDraft;
            draftEl.hidden = false;
            draftEl.innerHTML = `
                <div class="cm-cp-draft-label">本編への指示（編集できます）</div>
                <textarea class="cm-cp-draft-text" rows="5">${escapeHtml(consultDraft)}</textarea>
                <div class="cm-cp-draft-btns">
                    <button type="button" data-cp="draft-set">この内容でセット</button>
                    <button type="button" data-cp="draft-cancel">やめる</button>
                </div>`;
        }
    }
}

function onConsultPanelClick(e) {
    const btn = e.target.closest('[data-cp]');
    if (!btn) {
        if (e.target.closest('.cm-cp-send')) {
            if (consultBusy) {
                if (consultAbort) consultAbort.abort();
            } else {
                sendConsult();
            }
        }
        return;
    }
    const act = btn.dataset.cp;
    if (act === 'distill') distillConsult();
    if (act === 'draft-set') {
        const store = getStore();
        const ta = document.querySelector('#cm-consult-panel .cm-cp-draft-text');
        const text = (ta?.value || '').trim();
        if (store && text) {
            store.pendingInstruction = text;
            store.consult.push({ role: 'note', text: '📌 本編への指示をセットしました（次の生成にだけ付きます）', ts: Date.now() });
            saveStore();
            consultDraft = null;
            renderConsult();
            if (typeof toastr !== 'undefined') toastr.success('次の本編の生成にだけ、この指示が付きます。');
        }
    }
    if (act === 'draft-cancel') {
        consultDraft = null;
        renderConsult();
    }
    if (act === 'close') toggleConsultPanel(false);
    if (act === 'min') {
        consultMinimized = !consultMinimized;
        const body = document.querySelector('#cm-consult-panel .cm-cp-body');
        if (body) body.hidden = consultMinimized;
        btn.textContent = consultMinimized ? '＋' : '―';
    }
    if (act === 'unarmed') {
        const store = getStore();
        if (store) {
            store.pendingInstruction = '';
            saveStore();
            renderConsult();
        }
    }
    if (act === 'clear') {
        const store = getStore();
        if (store && store.consult.length && window.confirm('相談履歴を消去しますか？')) {
            store.consult = [];
            saveStore();
            renderConsult();
        }
    }
}

async function consultContextSnapshot(store) {
    const s = getSettings();
    const parts = [];
    try {
        const block = await assembleBlock(store, s.memoryBudgetTokens + 800);
        if (block) parts.push(`[Current cast memory state]\n${block}`);
    } catch (e) { /* context is best-effort */ }
    try {
        const { chat, name1 } = SillyTavern.getContext();
        if (Array.isArray(chat)) {
            const tail = chat.filter(m => m && m.mes && !m.is_system).slice(-12);
            if (tail.length) {
                const lines = tail.map(m => {
                    const name = m.name || (m.is_user ? name1 : '');
                    const text = String(m.mes).slice(0, 1000);
                    return `${name}: ${text}`;
                });
                parts.push(`[Recent story messages]\n${lines.join('\n')}`);
            }
        }
    } catch (e) { /* best-effort */ }
    return parts.join('\n\n');
}

let consultAbort = null;

// Generates one consult reply. When a Connection Manager profile is
// chosen for the consult window, the reply streams into the live
// bubble; otherwise it falls back to generateRaw on the main
// connection (whole reply at once).
async function consultGenerate(ctx, systemPrompt, turns, liveEl) {
    const s = getSettings();
    const svc = ctx.ConnectionManagerRequestService;
    if (s.consultProfileId && svc && typeof svc.sendRequest === 'function') {
        const messages = [{ role: 'system', content: systemPrompt }, ...turns];
        let text = '';
        const ac = new AbortController();
        consultAbort = ac;
        try {
            const res = await svc.sendRequest(s.consultProfileId, messages, 1200, {
                stream: true, extractData: true, includePreset: false, signal: ac.signal,
            });
            if (typeof res === 'function') {
                for await (const chunk of res()) {
                    if (chunk && typeof chunk.text === 'string') text = chunk.text;
                    if (liveEl) {
                        liveEl.textContent = stripBlocks(text) || '…';
                        const msgs = liveEl.closest('.cm-cp-msgs');
                        if (msgs) msgs.scrollTop = msgs.scrollHeight;
                    }
                }
                return text;
            }
            return (res && typeof res.content === 'string') ? res.content : '';
        } catch (e) {
            if (ac.signal.aborted) return text; // stopped by the user: keep what arrived
            warn('consult streaming failed, retrying without streaming:', e);
            const res = await svc.sendRequest(s.consultProfileId, messages, 1200, {
                stream: false, extractData: true, includePreset: false,
            });
            return (res && typeof res.content === 'string') ? res.content : '';
        } finally {
            consultAbort = null;
        }
    }
    const raw = await ctx.generateRaw({ systemPrompt, prompt: turns, responseLength: 1200 });
    return String(raw || '');
}

// Distills the whole consultation into a single self-contained GM
// instruction and parks it in the draft editor for confirmation.
async function distillConsult() {
    if (consultBusy) return;
    const panel = document.getElementById('cm-consult-panel');
    const store = getStore();
    if (!panel || !store) return;
    const ctx = SillyTavern.getContext();
    consultBusy = true;
    const sendBtn = panel.querySelector('.cm-cp-send');
    const canStop = !!getSettings().consultProfileId;
    if (sendBtn) {
        sendBtn.textContent = canStop ? '停止' : '…';
        sendBtn.disabled = !canStop;
    }
    let liveEl = null;
    const msgsEl = panel.querySelector('.cm-cp-msgs');
    if (msgsEl) {
        const wrap = document.createElement('div');
        wrap.className = 'cm-cp-msg cm-cp-assistant';
        wrap.innerHTML = '<div class="cm-cp-bubble cm-cp-live">…</div>';
        msgsEl.appendChild(wrap);
        liveEl = wrap.querySelector('.cm-cp-live');
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    try {
        const snapshot = await consultContextSnapshot(store);
        const systemPrompt = snapshot ? `${CONSULT_DISTILL_PROMPT}\n\n${snapshot}` : CONSULT_DISTILL_PROMPT;
        const turns = store.consult
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-20)
            .map(m => ({ role: m.role, content: m.text }));
        const raw = await consultGenerate(ctx, systemPrompt, turns, liveEl);
        const text = stripBlocks(cleanModelText(String(raw || '')));
        if (!text) throw new Error('empty distillation');
        consultDraft = text;
    } catch (e) {
        warn('consult distillation failed:', e);
        if (typeof toastr !== 'undefined') toastr.error('指示へのまとめに失敗しました。');
    } finally {
        consultBusy = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '送信'; }
        renderConsult();
    }
}

async function sendConsult() {
    if (consultBusy) return;
    const panel = document.getElementById('cm-consult-panel');
    const input = panel?.querySelector('.cm-cp-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    const store = getStore();
    if (!store) return;
    const ctx = SillyTavern.getContext();
    if (typeof ctx.generateRaw !== 'function' && !getSettings().consultProfileId) {
        if (typeof toastr !== 'undefined') toastr.error('このSillyTavernでは相談窓の生成APIが使えません。');
        return;
    }
    if (input) input.value = '';
    store.consult.push({ role: 'user', text, ts: Date.now() });
    saveStore();
    renderConsult();

    consultBusy = true;
    const sendBtn = panel.querySelector('.cm-cp-send');
    const canStop = !!getSettings().consultProfileId;
    if (sendBtn) {
        sendBtn.textContent = canStop ? '停止' : '…';
        sendBtn.disabled = !canStop;
    }
    // Live bubble the streamed reply flows into (removed by the
    // renderConsult in finally).
    let liveEl = null;
    const msgsEl = panel.querySelector('.cm-cp-msgs');
    if (msgsEl) {
        const wrap = document.createElement('div');
        wrap.className = 'cm-cp-msg cm-cp-assistant';
        wrap.innerHTML = '<div class="cm-cp-bubble cm-cp-live">…</div>';
        msgsEl.appendChild(wrap);
        liveEl = wrap.querySelector('.cm-cp-live');
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    try {
        const snapshot = await consultContextSnapshot(store);
        const systemPrompt = snapshot ? `${CONSULT_SYSTEM_PROMPT}\n\n${snapshot}` : CONSULT_SYSTEM_PROMPT;
        const turns = store.consult
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-20)
            .map(m => ({ role: m.role, content: m.text }));
        const raw = await consultGenerate(ctx, systemPrompt, turns, liveEl);
        const reply = cleanModelText(String(raw || ''));
        if (!reply) throw new Error('empty reply');

        // Declaration blocks in the reply are data operations: apply
        // them to the store right away and keep them out of the prose.
        const blocks = parseBlocks(reply);
        const applied = [];
        if (blocks.length) {
            const { chat } = ctx;
            const idx = Array.isArray(chat) ? chat.length - 1 : 0;
            for (const b of blocks) {
                if (applyBlock(store, b, idx)) applied.push(describeBlock(b));
            }
        }
        const prose = stripBlocks(reply);
        if (prose) store.consult.push({ role: 'assistant', text: prose, ts: Date.now() });
        if (applied.length) {
            store.consult.push({ role: 'note', text: `✅ ${applied.join('／')}`, ts: Date.now() });
        }
        if (!prose && !applied.length) {
            store.consult.push({ role: 'note', text: '（返答が空でした）', ts: Date.now() });
        }
        saveStore();
        updateUI();
    } catch (e) {
        warn('consult generation failed:', e);
        store.consult.push({ role: 'note', text: '⚠️ 生成に失敗しました。接続を確認して、もう一度送ってみてください。', ts: Date.now() });
        saveStore();
    } finally {
        consultBusy = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '送信'; }
        renderConsult();
    }
}

function buildWandMenuEntry() {
    if (document.getElementById('cm-wand-entry')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const entry = document.createElement('div');
    entry.id = 'cm-wand-entry';
    entry.className = 'list-group-item flex-container flexGap5';
    entry.style.cursor = 'pointer';
    entry.innerHTML = '<div class="fa-solid fa-masks-theater extensionsMenuExtensionButton"></div><span>Cast Memory</span>';
    entry.addEventListener('click', () => {
        openSheet();
        const btn = document.getElementById('extensionsMenuButton');
        if (btn) btn.click();
    });
    menu.appendChild(entry);
}

/** Open ST's extension settings drawer at the Cast Memory section. */
function openCmSettings() {
    try {
        const block = document.querySelector('.cm-settings');
        const drawer = document.getElementById('extensions-settings-button');
        // ST binds the drawer open/close handler on the .drawer-toggle
        // child — clicking the .drawer container itself does nothing.
        const toggle = drawer ? drawer.querySelector('.drawer-toggle') : null;
        if (block && toggle) {
            const content = document.getElementById('rm_extensions_block');
            const isOpen = content && !content.classList.contains('closedDrawer');
            if (!isOpen) toggle.click();
            setTimeout(() => {
                try { block.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* noop */ }
            }, 350);
            return;
        }
    } catch (e) { /* fall through to the sheet */ }
    openSheet('ops');
}

// The sheet is plain content shown through SillyTavern's own Popup API —
// the mobile-safe way to show overlay UI in ST (custom position:fixed
// sheets are displaced by ST's transformed <html> containing block).
function buildSheetContent() {
    if (cmSheetEl) return cmSheetEl;
    const el = document.createElement('div');
    el.className = 'cm-sheet-content';
    el.innerHTML = `
        <div class="cm-sheet-status"></div>
        <div class="cm-tabs">
            <button class="cm-tab" type="button" data-act="tab" data-tab="cast">🎭 キャラクター</button>
            <button class="cm-tab" type="button" data-act="tab" data-tab="world">🌍 ワールド</button>
            <button class="cm-tab" type="button" data-act="tab" data-tab="ops">⚙️ 操作</button>
        </div>
        <div class="cm-view cm-view-cast"></div>
        <div class="cm-view cm-view-world" hidden></div>
        <div class="cm-view cm-view-ops" hidden>
            <div class="cm-ops-btns">
                <button class="cm-btn" type="button" data-act="scene-close">🎬 場面を締めて記憶を書く</button>
                <button class="cm-btn" type="button" data-act="ghost-all">👻 書込済みを一括ゴースト化</button>
                <button class="cm-btn" type="button" data-act="rewind">🔁 最後の書き込みを取り消して書き直す</button>
                <button class="cm-btn" type="button" data-act="unapply">↩️ 反映を解除（原文を全部戻す）</button>
                <button class="cm-btn cm-btn-danger" type="button" data-act="clear">🗑 全データを消去</button>
            </div>
            <div class="cm-addchar">
                <div class="cm-addchar-title">キャラクターを手動で追加</div>
                <input class="cm-addchar-name text_pole" type="text" placeholder="名前">
                <button class="cm-btn" type="button" data-act="char-add">追加</button>
            </div>
            <div class="cm-ops-note">記憶の書き込みは「全員ログアウトした場面の終わり」か、未書込分が設定トークンを超えた時に自動でも行われます。書けていないメッセージは絶対に隠れません。</div>
            <div class="cm-section-title">注入の確認</div>
            <div class="cm-ops-btns">
                <button class="cm-btn" type="button" data-act="inj-last">📤 前回生成で実際に送った注入を見る</button>
                <button class="cm-btn" type="button" data-act="inj-preview">🔍 現在の状態で組み立てた注入を見る</button>
            </div>
            <div class="cm-inj-meta"></div>
            <div class="cm-inj-view" hidden></div>
        </div>`;
    el.addEventListener('click', onSheetClick);
    cmSheetEl = el;
    return el;
}

function openSheet(tab) {
    if (tab) cmTab = tab;
    if (cmPopupOpen) { renderSheet(); return; }
    const el = buildSheetContent();
    updateUI();
    try {
        const ctx = SillyTavern.getContext();
        cmPopupOpen = true;
        const popup = new ctx.Popup(el, ctx.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: '閉じる',
            allowVerticalScrolling: true,
            onClose: () => { cmPopupOpen = false; },
        });
        popup.show();
    } catch (e) {
        cmPopupOpen = false;
        noteError('openSheet/popup', e);
        toastr.error('Cast Memory: ポップアップを開けませんでした。');
    }
}

function formatDate(ts) {
    try {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch (e) { return ''; }
}

/** Render stored markdown the same way ST renders message text. */
function renderMd(text, name) {
    if (!text) return '';
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.messageFormatting === 'function') {
            return ctx.messageFormatting(text, name || '', false, false, 9999);
        }
    } catch (e) { /* fall through */ }
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function originalHtml(start, end) {
    const { chat, name1, name2 } = SillyTavern.getContext();
    const parts = [];
    for (let i = start; i <= end && i < chat.length; i++) {
        const m = chat[i];
        if (!m || !m.mes) continue;
        const name = m.name || (m.is_user ? name1 : name2);
        parts.push(`<div class="cm-orig-msg"><div class="cm-orig-name">${escapeHtml(name)}</div><div class="cm-orig-text">${escapeHtml(m.mes)}</div></div>`);
    }
    return parts.join('') || '<div class="cm-empty">原文が見つかりませんでした</div>';
}

function encName(name) { return encodeURIComponent(name); }
function decName(v) { try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; } }

// ─── Sheet rendering ─────────────────────────────────────────────────────────

function entryHtml(entry, kind, name) {
    const live = entry.end <= (getStore()?.appliedUpTo ?? -1);
    const badge = live
        ? '<span class="cm-badge cm-badge-live">✅ 反映中</span>'
        : '<span class="cm-badge cm-badge-stock">📦 記録済み</span>';
    return `
    <div class="cm-entry" data-kind="${kind}" data-id="${entry.id}" data-name="${name ? encName(name) : ''}">
        <div class="cm-entry-head">
            <span class="cm-entry-meta">msg ${entry.start}–${entry.end} · ${formatDate(entry.ts)}</span>${badge}
        </div>
        <div class="cm-entry-text mes_text">${renderMd(entry.text, name || '')}</div>
        <div class="cm-entry-btns">
            <button class="cm-btn cm-btn-small" type="button" data-act="entry-orig">原文を見る</button>
            <button class="cm-btn cm-btn-small cm-btn-danger" type="button" data-act="entry-del">この記憶を削除</button>
        </div>
        <div class="cm-orig" hidden></div>
    </div>`;
}

function renderCastView() {
    const view = cmSheetEl ? cmSheetEl.querySelector('.cm-view-cast') : null;
    if (!view) return;
    const store = getStore();
    if (!store) { view.innerHTML = '<div class="cm-empty">チャットが開かれていません</div>'; return; }

    if (cmSelectedChar && store.characters[cmSelectedChar]) {
        const name = cmSelectedChar;
        const ch = store.characters[name];
        const memHtml = ch.memories.length
            ? ch.memories.map(m => entryHtml(m, 'char', name)).join('')
            : '<div class="cm-empty">このキャラクターの記憶はまだありません</div>';
        const longTermHtml = ch.longTerm
            ? `<div class="cm-section-title">長期記憶（統合済み）</div><div class="cm-md mes_text">${renderMd(ch.longTerm, name)}</div>`
            : '';
        view.innerHTML = `
            <div class="cm-detail-head">
                <button class="cm-btn cm-btn-small" type="button" data-act="char-back">← 一覧へ</button>
                <span class="cm-detail-name">${escapeHtml(name)}</span>
                <span class="cm-badge ${ch.present ? 'cm-badge-live' : 'cm-badge-stock'}">${ch.present ? '🟢 登場中' : '⚪ 退場中'}</span>
            </div>
            <div class="cm-detail-btns">
                <button class="cm-btn cm-btn-small" type="button" data-act="presence-toggle" data-name="${encName(name)}">${ch.present ? 'ログアウトさせる' : 'ログインさせる'}</button>
                <button class="cm-btn cm-btn-small" type="button" data-act="char-rename" data-name="${encName(name)}">名前を変更</button>
                <button class="cm-btn cm-btn-small cm-btn-danger" type="button" data-act="char-del" data-name="${encName(name)}">キャラを削除</button>
            </div>
            <div class="cm-section-title">プロフィール</div>
            <div class="cm-md mes_text">${ch.profile ? renderMd(ch.profile, name) : '<span class="cm-empty">（未登録）</span>'}</div>
            <div class="cm-editbox cm-profile-edit" hidden>
                <textarea class="cm-edit-text text_pole" rows="8">${escapeHtml(ch.profile)}</textarea>
                <div class="cm-entry-btns">
                    <button class="cm-btn cm-btn-small" type="button" data-act="profile-save" data-name="${encName(name)}">保存</button>
                    <button class="cm-btn cm-btn-small" type="button" data-act="profile-cancel">キャンセル</button>
                </div>
            </div>
            <button class="cm-btn cm-btn-small" type="button" data-act="profile-edit">プロフィールを編集</button>
            ${longTermHtml}
            <div class="cm-section-title">記憶（${ch.memories.length}件）</div>
            ${memHtml}`;
        return;
    }

    const names = characterNames(store);
    if (names.length === 0) {
        view.innerHTML = '<div class="cm-empty">まだキャラクターが登録されていません。<br>モデルがキャラクター作成ブロックを出すか、「操作」タブから手動で追加できます。</div>';
        return;
    }
    const sorted = [...names].sort((a, b) => {
        const pa = store.characters[a].present ? 0 : 1;
        const pb = store.characters[b].present ? 0 : 1;
        return pa - pb || (store.characters[b].updated || 0) - (store.characters[a].updated || 0);
    });
    view.innerHTML = sorted.map(n => {
        const ch = store.characters[n];
        const one = profileOneLiner(ch.profile);
        return `
        <div class="cm-char-row" data-act="char-open" data-name="${encName(n)}">
            <span class="cm-char-dot">${ch.present ? '🟢' : '⚪'}</span>
            <span class="cm-char-main">
                <span class="cm-char-name">${escapeHtml(n)}</span>
                <span class="cm-char-sub">${escapeHtml(one || 'プロフィール未登録')} · 記憶 ${ch.memories.length}件${ch.longTerm ? '＋長期' : ''}</span>
            </span>
            <span class="cm-char-arrow">›</span>
        </div>`;
    }).join('');
}

function renderWorldView() {
    const view = cmSheetEl ? cmSheetEl.querySelector('.cm-view-world') : null;
    if (!view) return;
    const store = getStore();
    if (!store) { view.innerHTML = '<div class="cm-empty">チャットが開かれていません</div>'; return; }

    // Location detail view (selected from the list below).
    if (cmSelectedLoc && store.locations[cmSelectedLoc]) {
        const name = cmSelectedLoc;
        const loc = store.locations[name];
        const isCur = store.currentLocation === name;
        view.innerHTML = `
            <div class="cm-detail-head">
                <button class="cm-btn cm-btn-small" type="button" data-act="loc-back">← ワールドへ</button>
                <span class="cm-detail-name">📍 ${escapeHtml(name)}</span>
                ${isCur ? '<span class="cm-badge cm-badge-live">現在地</span>' : ''}
            </div>
            <div class="cm-detail-btns">
                <button class="cm-btn cm-btn-small" type="button" data-act="loc-here" data-name="${encName(name)}">${isCur ? '現在地を解除' : '現在地に設定'}</button>
                <button class="cm-btn cm-btn-small cm-btn-danger" type="button" data-act="loc-del" data-name="${encName(name)}">場所を削除</button>
            </div>
            <div class="cm-section-title">場所の詳細</div>
            <div class="cm-md mes_text">${loc.detail ? renderMd(loc.detail, '') : '<span class="cm-empty">（未登録）</span>'}</div>
            <div class="cm-editbox cm-loc-edit" hidden>
                <textarea class="cm-edit-text text_pole" rows="8">${escapeHtml(loc.detail)}</textarea>
                <div class="cm-entry-btns">
                    <button class="cm-btn cm-btn-small" type="button" data-act="loc-save" data-name="${encName(name)}">保存</button>
                    <button class="cm-btn cm-btn-small" type="button" data-act="loc-cancel">キャンセル</button>
                </div>
            </div>
            <button class="cm-btn cm-btn-small" type="button" data-act="loc-edit">詳細を編集</button>`;
        return;
    }

    const locNames = locationNames(store);
    const locHtml = locNames.length
        ? locNames.map(n => {
            const loc = store.locations[n];
            const one = profileOneLiner(loc.detail);
            const cur = store.currentLocation === n;
            return `<div class="cm-char-row" data-act="loc-open" data-name="${encName(n)}">
                <span class="cm-char-name">${cur ? '📍 ' : ''}${escapeHtml(n)}</span>
                ${cur ? '<span class="cm-badge cm-badge-live">現在地</span>' : ''}
                <span class="cm-char-one">${escapeHtml(one)}</span>
            </div>`;
        }).join('')
        : '<div class="cm-empty">場所はまだ登録されていません</div>';

    const entries = store.worldEntries.length
        ? store.worldEntries.map(e => entryHtml(e, 'world', '')).join('')
        : '<div class="cm-empty">ワールド記憶はまだありません</div>';
    view.innerHTML = `
        <div class="cm-section-title">場所（${locNames.length}件）</div>
        ${locHtml}
        <div class="cm-addchar">
            <input class="cm-addloc-name text_pole" type="text" placeholder="場所名を入力して手動追加" />
            <button class="cm-btn cm-btn-small" type="button" data-act="loc-add">追加</button>
        </div>
        <div class="cm-section-title">ワールド情報（設定）</div>
        <div class="cm-md mes_text">${store.worldSetting ? renderMd(store.worldSetting, '') : '<span class="cm-empty">（未登録）</span>'}</div>
        <div class="cm-editbox cm-world-edit" hidden>
            <textarea class="cm-edit-text text_pole" rows="8">${escapeHtml(store.worldSetting)}</textarea>
            <div class="cm-entry-btns">
                <button class="cm-btn cm-btn-small" type="button" data-act="world-save">保存</button>
                <button class="cm-btn cm-btn-small" type="button" data-act="world-cancel">キャンセル</button>
            </div>
        </div>
        <button class="cm-btn cm-btn-small" type="button" data-act="world-edit">ワールド情報を編集</button>
        ${store.worldLongTerm ? `<div class="cm-section-title">ワールド長期記憶（統合済み）</div><div class="cm-md mes_text">${renderMd(store.worldLongTerm, '')}</div>` : ''}
        <div class="cm-section-title">ワールド記憶（${store.worldEntries.length}件）</div>
        ${entries}`;
}

function renderSheet() {
    if (!cmSheetEl) return;
    cmSheetEl.querySelectorAll('.cm-tab').forEach(t => {
        t.classList.toggle('cm-tab-active', t.dataset.tab === cmTab);
    });
    const cast = cmSheetEl.querySelector('.cm-view-cast');
    const world = cmSheetEl.querySelector('.cm-view-world');
    const ops = cmSheetEl.querySelector('.cm-view-ops');
    if (cast) cast.hidden = cmTab !== 'cast';
    if (world) world.hidden = cmTab !== 'world';
    if (ops) ops.hidden = cmTab !== 'ops';
    renderCastView();
    renderWorldView();
    const status = cmSheetEl.querySelector('.cm-sheet-status');
    if (status) status.textContent = statusText();
}

// ─── Sheet actions ───────────────────────────────────────────────────────────

async function onSheetClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const store = getStore();

    if (act === 'tab') {
        cmTab = btn.dataset.tab;
        renderSheet();
        return;
    }
    if (!store) return;

    switch (act) {
        case 'char-open':
            cmSelectedChar = decName(btn.dataset.name);
            renderSheet();
            break;
        case 'char-back':
            cmSelectedChar = null;
            renderSheet();
            break;
        case 'presence-toggle': {
            const name = decName(btn.dataset.name);
            const ch = store.characters[name];
            if (!ch) break;
            ch.present = !ch.present;
            ch.updated = Date.now();
            const { chat } = SillyTavern.getContext();
            store.presence.push({ index: Math.max(0, (chat?.length || 1) - 1), name, action: ch.present ? 'login' : 'logout' });
            saveStore();
            renderSheet();
            updateFloat();
            break;
        }
        case 'char-rename': {
            const name = decName(btn.dataset.name);
            const newName = (prompt(`「${name}」の新しい名前（判明した本名など）`, name) || '').trim();
            if (!newName || newName === name) break;
            if (!renameCharacter(store, name, newName)) { toastr.error('名前を変更できませんでした', 'Cast Memory'); break; }
            if (cmSelectedChar === name) cmSelectedChar = newName;
            saveStore();
            renderSheet();
            toastr.success(`「${name}」→「${newName}」に変更しました`, 'Cast Memory');
            break;
        }
        case 'char-del': {
            const name = decName(btn.dataset.name);
            if (!confirm(`キャラクター「${name}」とその記憶を全て削除しますか？`)) break;
            delete store.characters[name];
            store.presence = store.presence.filter(p => p.name !== name);
            if (cmSelectedChar === name) cmSelectedChar = null;
            saveStore();
            renderSheet();
            break;
        }
        case 'char-add': {
            const input = cmSheetEl.querySelector('.cm-addchar-name');
            const name = (input?.value || '').trim();
            if (!name) { toastr.warning('名前を入力してください', 'Cast Memory'); break; }
            getCharacter(store, name);
            if (input) input.value = '';
            saveStore();
            cmSelectedChar = name;
            cmTab = 'cast';
            renderSheet();
            toastr.success(`「${name}」を追加しました`, 'Cast Memory');
            break;
        }
        case 'profile-edit':
            cmSheetEl.querySelector('.cm-profile-edit').hidden = false;
            break;
        case 'profile-cancel':
            cmSheetEl.querySelector('.cm-profile-edit').hidden = true;
            break;
        case 'profile-save': {
            const name = decName(btn.dataset.name);
            const ta = cmSheetEl.querySelector('.cm-profile-edit .cm-edit-text');
            const ch = store.characters[name];
            if (ch && ta) {
                ch.profile = ta.value.trim();
                ch.updated = Date.now();
                saveStore();
                toastr.success('プロフィールを保存しました', 'Cast Memory');
            }
            renderSheet();
            break;
        }
        case 'loc-open': {
            cmSelectedLoc = decName(btn.dataset.name);
            cmTab = 'world';
            renderSheet();
            break;
        }
        case 'loc-back':
            cmSelectedLoc = null;
            renderSheet();
            break;
        case 'loc-add': {
            const input = cmSheetEl.querySelector('.cm-addloc-name');
            const name = (input?.value || '').trim();
            if (!name) { toastr.warning('場所名を入力してください', 'Cast Memory'); break; }
            getLocation(store, name);
            saveStore();
            cmSelectedLoc = name;
            updateUI();
            toastr.success(`場所「${name}」を追加しました`, 'Cast Memory');
            break;
        }
        case 'loc-del': {
            const name = decName(btn.dataset.name);
            if (!confirm(`場所「${name}」を削除しますか？`)) break;
            delete store.locations[name];
            if (store.currentLocation === name) store.currentLocation = '';
            if (cmSelectedLoc === name) cmSelectedLoc = null;
            saveStore();
            updateUI();
            break;
        }
        case 'loc-here': {
            const name = decName(btn.dataset.name);
            store.currentLocation = store.currentLocation === name ? '' : name;
            saveStore();
            updateUI();
            break;
        }
        case 'loc-edit':
            cmSheetEl.querySelector('.cm-loc-edit').hidden = false;
            break;
        case 'loc-cancel':
            cmSheetEl.querySelector('.cm-loc-edit').hidden = true;
            break;
        case 'loc-save': {
            const name = decName(btn.dataset.name);
            const ta = cmSheetEl.querySelector('.cm-loc-edit .cm-edit-text');
            const loc = store.locations[name];
            if (ta && loc) {
                loc.detail = ta.value.trim();
                loc.updated = Date.now();
                saveStore();
                toastr.success('場所の詳細を保存しました', 'Cast Memory');
            }
            updateUI();
            break;
        }
        case 'world-edit':
            cmSheetEl.querySelector('.cm-world-edit').hidden = false;
            break;
        case 'world-cancel':
            cmSheetEl.querySelector('.cm-world-edit').hidden = true;
            break;
        case 'world-save': {
            const ta = cmSheetEl.querySelector('.cm-world-edit .cm-edit-text');
            if (ta) {
                store.worldSetting = ta.value.trim();
                saveStore();
                toastr.success('ワールド情報を保存しました', 'Cast Memory');
            }
            renderSheet();
            break;
        }
        case 'entry-orig': {
            const entryEl = btn.closest('.cm-entry');
            const orig = entryEl ? entryEl.querySelector('.cm-orig') : null;
            if (!orig) break;
            if (orig.hidden && !orig.dataset.loaded) {
                const kind = entryEl.dataset.kind;
                const id = entryEl.dataset.id;
                const name = decName(entryEl.dataset.name);
                const entry = kind === 'world'
                    ? store.worldEntries.find(x => x.id === id)
                    : store.characters[name]?.memories.find(x => x.id === id);
                if (entry) {
                    orig.innerHTML = originalHtml(entry.start, entry.end);
                    orig.dataset.loaded = '1';
                }
            }
            orig.hidden = !orig.hidden;
            break;
        }
        case 'entry-del': {
            const entryEl = btn.closest('.cm-entry');
            if (!entryEl) break;
            if (!confirm('この記憶を削除しますか？（対応する原文は既に隠れている場合、情報が失われます）')) break;
            const kind = entryEl.dataset.kind;
            const id = entryEl.dataset.id;
            const name = decName(entryEl.dataset.name);
            if (kind === 'world') {
                store.worldEntries = store.worldEntries.filter(x => x.id !== id);
            } else if (store.characters[name]) {
                store.characters[name].memories = store.characters[name].memories.filter(x => x.id !== id);
            }
            saveStore();
            renderSheet();
            break;
        }
        case 'inj-last': {
            const view = cmSheetEl.querySelector('.cm-inj-view');
            const meta = cmSheetEl.querySelector('.cm-inj-meta');
            if (!view) break;
            if (!lastInjected.text) {
                meta.textContent = 'まだ注入の記録がありません（このセッションで生成すると記録されます）';
                view.hidden = true;
                break;
            }
            const tokens = await estimateTextTokens(lastInjected.text);
            meta.textContent = `前回生成 ${formatDate(lastInjected.at)} の注入 — 約 ${tokens} tok / ${lastInjected.text.length} 字`;
            view.textContent = lastInjected.text;
            view.hidden = false;
            break;
        }
        case 'inj-preview': {
            const view = cmSheetEl.querySelector('.cm-inj-view');
            const meta = cmSheetEl.querySelector('.cm-inj-meta');
            if (!view) break;
            const s = getSettings();
            const text = await assembleBlock(store, s.memoryBudgetTokens + 800);
            if (!text) {
                meta.textContent = '現在の状態では注入される内容がありません';
                view.hidden = true;
                break;
            }
            const tokens = await estimateTextTokens(text);
            meta.textContent = `現在の状態での注入プレビュー — 約 ${tokens} tok / ${text.length} 字`;
            view.textContent = text;
            view.hidden = false;
            break;
        }
        case 'scene-close': {            if (isWorking) { toastr.info('作業中です…', 'Cast Memory'); break; }
            toastr.info('場面を締めて記憶を書いています…', 'Cast Memory');
            const ok = await maybeWriteScene(true);
            if (ok) toastr.success('記憶を書き込みました', 'Cast Memory');
            else if (lastWriterError) toastr.error(`書き込みエラー: ${lastWriterError}`, 'Cast Memory');
            else toastr.info('書く対象がありませんでした', 'Cast Memory');
            renderSheet();
            break;
        }
        case 'ghost-all': {
            const target = ghostTarget(store);
            if (target < 0) { toastr.info('まだ記憶に書かれた範囲がありません', 'Cast Memory'); break; }
            if (target <= store.appliedUpTo) { toastr.info('書込済みの範囲はすでに全部ゴースト化されています', 'Cast Memory'); break; }
            if (!confirm(`メッセージ ${target} までをゴースト化します。直近を生で残すルールより優先して、書込済みの範囲を全部隠します（記憶は注入され続けます。「反映を解除」で戻せます）。`)) break;
            const done = ghostAllNow();
            try { await SillyTavern.getContext().saveChat(); } catch (err) { /* noop */ }
            toastr.success(`メッセージ ${done} までゴースト化しました`, 'Cast Memory');
            renderSheet();
            break;
        }
        case 'rewind': {
            if (isWorking) { toastr.info('作業中です…', 'Cast Memory'); break; }
            const st = getStore();
            if (!st?.lastWrite) { toastr.info('取り消せる書き込みがありません', 'Cast Memory'); break; }
            if (!confirm('最後の書き込み（キャラ記憶・ワールド記憶）を取り消して、同じ範囲を書き直しますか？')) break;
            toastr.info('最後の書き込みを書き直しています…', 'Cast Memory');
            const ok = await rewindLastWrite();
            if (ok) toastr.success('書き直しました', 'Cast Memory');
            else if (lastWriterError) toastr.error(`書き直しエラー: ${lastWriterError}`, 'Cast Memory');
            else toastr.info('書き直せませんでした', 'Cast Memory');
            renderSheet();
            break;
        }
        case 'unapply': {
            unapplyAll();
            try { await SillyTavern.getContext().saveChat(); } catch (err) { /* noop */ }
            toastr.success('反映を解除しました。原文が全てプロンプトに戻ります', 'Cast Memory');
            renderSheet();
            break;
        }
        case 'clear': {
            if (!confirm('Cast Memory の全データ（キャラ・記憶・ワールド）を消去しますか？原文は全て戻ります。')) break;
            await clearAllData();
            cmSelectedChar = null;
            renderSheet();
            break;
        }
    }
}

// ─── Status / FAB ────────────────────────────────────────────────────────────

function statusText() {
    const store = getStore();
    if (!store) return 'チャットが開かれていません';
    const names = characterNames(store);
    const present = presentNames(store).length;
    const est = tokenCountSource === 'estimate' ? '（概算）' : '';
    let tok;
    if (lastTokenEstimate >= 0 && lastInjectedTokens >= 0) {
        tok = `送信合計 ≈ ${lastTokenEstimate + lastInjectedTokens} tok${est}（履歴 ${lastTokenEstimate} ＋ 注入 ${lastInjectedTokens}）`;
    } else if (lastTokenEstimate >= 0) {
        tok = `履歴 ≈ ${lastTokenEstimate} tok${est}`;
    } else {
        tok = '履歴 ≈ ? tok';
    }
    const unwritten = lastUnwrittenEstimate >= 0 ? `未書込 ≈ ${lastUnwrittenEstimate} tok` : '';
    const gen = !lastGen.at ? '前回生成: —' : (lastGen.included ? '前回生成: 記録あり ✓' : '前回生成: 記録なし');
    const work = isWorking ? ' · 記憶を作成中…' : '';
    const err = lastWriterError ? ` · ⚠️ ${lastWriterError}` : '';
    const drop = lastDroppedNote ? ` · ⚠️ ${lastDroppedNote}` : '';
    return `${tok}${unwritten ? ` ／ ${unwritten}` : ''} ／ キャラ ${names.length}（登場中 ${present}） ／ 書込済 msg ${store.writtenUpTo}・反映済 msg ${store.appliedUpTo} ／ ${gen}${work}${err}${drop}`;
}

function updateFloat() {
    const s = getSettings();
    const store = getStore();

    const el = document.getElementById('cm-float');
    if (el) {
        // Badge on the round button: number of characters on stage.
        const badge = el.querySelector('.cm-fab-badge');
        if (badge) {
            const present = store ? presentNames(store).length : 0;
            badge.textContent = String(present);
            badge.hidden = present === 0;
        }
        // While the sub model is writing memories, the mask becomes a spinner.
        const face = el.querySelector('.cm-fab-face');
        const spinner = el.querySelector('.cm-fab-spinner');
        if (face) face.hidden = isWorking;
        if (spinner) spinner.hidden = !isWorking;
        el.style.opacity = s.enabled ? '1' : '0.45';
    }

    // Location chip float: current place name only (no expansion).
    const chip = document.getElementById('cm-loc-float');
    if (chip) {
        const locName = chip.querySelector('.cm-loc-name');
        if (locName) locName.textContent = store?.currentLocation || '現在地未設定';
        chip.style.opacity = s.enabled ? '1' : '0.45';
    }
}

function updateUI() {
    try {
        updateFloat();
        if (cmSheetEl) renderSheet();
        if (document.getElementById('cm-consult-panel')) renderConsult();
        const panelStatus = document.getElementById('cm_status');
        if (panelStatus) panelStatus.textContent = statusText();
    } catch (e) { /* UI is best-effort */ }
    applyGhostStyles();
    refreshExtensionPrompt().catch(() => {});
}

// ─── Settings panel actions ──────────────────────────────────────────────────

function bindActions() {
    $(document).on('click', '.cm-act-open', function () {
        openSheet();
    });
}

// ─── Settings panel ──────────────────────────────────────────────────────────

function populateProfiles() {
    const s = getSettings();
    try {
        const svc = SillyTavern.getContext().ConnectionManagerRequestService;
        if (!svc || typeof svc.handleDropdown !== 'function') return;
        const select = document.getElementById('cm_profile');
        if (select) {
            svc.handleDropdown(select);
            if (s.profileId) select.value = s.profileId;
        }
        const consultSelect = document.getElementById('cm_consult_profile');
        if (consultSelect) {
            svc.handleDropdown(consultSelect, s.consultProfileId || '');
            consultSelect.value = s.consultProfileId || '';
        }
    } catch (e) { warn('populateProfiles failed:', e); }
}

function syncSourcePanels() {
    const s = getSettings();
    const map = { profile: 'cm_profile_wrap', openai: 'cm_openai_wrap', ollama: 'cm_ollama_wrap' };
    for (const [key, id] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) el.style.display = (s.connectionSource === key) ? 'block' : 'none';
    }
    if (s.connectionSource === 'profile') populateProfiles();
}

function syncSettingsForm() {
    const s = getSettings();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    chk('cm_enabled', s.enabled);
    chk('cm_ghost', s.ghostVisuals);
    set('cm_injection', s.injectionMethod);
    set('cm_tail', s.keepTailMessages);
    set('cm_threshold', s.sceneThresholdTokens);
    set('cm_turns', s.sceneTurnLimit);
    set('cm_budget', s.memoryBudgetTokens);
    set('cm_fold', s.foldCharThreshold);
    set('cm_resp_len', s.summarizerResponseLength);
    set('cm_source', s.connectionSource);
    set('cm_oai_url', s.openaiUrl);
    set('cm_oai_key', s.openaiKey);
    set('cm_oai_model', s.openaiModel);
    set('cm_ollama_url', s.ollamaUrl);
    set('cm_ollama_model', s.ollamaModel);
    set('cm_writer_sys', s.writerSystemPrompt);
    set('cm_writer_user', s.writerUserPrompt);
    set('cm_fold_user', s.foldUserPrompt);
    set('cm_wfold_user', s.worldFoldUserPrompt);
    syncSourcePanels();
    populateProfiles();
}

function bindSettings() {
    const num = (id, key) => {
        $(document).on('input', `#${id}`, function () {
            const v = parseInt($(this).val(), 10);
            if (Number.isFinite(v) && v >= 0) { getSettings()[key] = v; saveSettings(); updateUI(); }
        });
    };
    const txt = (id, key) => {
        $(document).on('input', `#${id}`, function () {
            getSettings()[key] = $(this).val();
            saveSettings();
        });
    };
    $(document).on('change', '#cm_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings(); updateUI();
    });
    $(document).on('change', '#cm_ghost', function () {
        getSettings().ghostVisuals = $(this).prop('checked');
        saveSettings(); updateUI();
    });
    $(document).on('change', '#cm_injection', function () {
        getSettings().injectionMethod = $(this).val();
        lastRegisteredBlock = null; // force re-registration under the new mode
        saveSettings(); updateUI();
        toastr.info(`注入方式を「${$(this).val() === 'extension' ? '拡張プロンプトブロック' : 'インターセプター'}」に切り替えました`, 'Cast Memory');
    });
    num('cm_tail', 'keepTailMessages');
    num('cm_threshold', 'sceneThresholdTokens');
    num('cm_turns', 'sceneTurnLimit');
    num('cm_budget', 'memoryBudgetTokens');
    num('cm_fold', 'foldCharThreshold');
    num('cm_resp_len', 'summarizerResponseLength');
    txt('cm_oai_url', 'openaiUrl');
    txt('cm_oai_key', 'openaiKey');
    txt('cm_oai_model', 'openaiModel');
    txt('cm_ollama_url', 'ollamaUrl');
    txt('cm_ollama_model', 'ollamaModel');
    txt('cm_writer_sys', 'writerSystemPrompt');
    txt('cm_writer_user', 'writerUserPrompt');
    txt('cm_fold_user', 'foldUserPrompt');
    txt('cm_wfold_user', 'worldFoldUserPrompt');
    $(document).on('change', '#cm_source', function () {
        getSettings().connectionSource = $(this).val();
        saveSettings();
        syncSourcePanels();
    });
    $(document).on('change', '#cm_profile', function () {
        getSettings().profileId = $(this).val();
        saveSettings();
    });
    $(document).on('change', '#cm_consult_profile', function () {
        getSettings().consultProfileId = $(this).val();
        saveSettings();
    });
}

// ─── Init ────────────────────────────────────────────────────────────────────

function initCastMemory() {
    jQuery(async () => {
        const ctx = SillyTavern.getContext();
        try {
            const html = await ctx.renderExtensionTemplateAsync('third-party/Extension-CastMemory', 'settings');
            $('#extensions_settings2').append(html);
        } catch (e) {
            warn('settings template failed to load:', e);
        }
        try { buildFabAndSheet(); } catch (e) { noteError('buildFabAndSheet', e); }
        try { buildWandMenuEntry(); } catch (e) { noteError('buildWandMenuEntry', e); }
        // The quick bar above the send form was removed in v2.5.0; clean
        // up an element left over from an older version in this session.
        document.getElementById('cm-sendbtns')?.remove();
        try { bindSettings(); } catch (e) { noteError('bindSettings', e); }
        try { bindActions(); } catch (e) { noteError('bindActions', e); }
        try { syncSettingsForm(); } catch (e) { noteError('syncSettingsForm', e); }
        // Watchdog: recreate UI elements if ST's startup removes them.
        let cmWatchTries = 0;
        const cmWatch = setInterval(() => {
            cmWatchTries++;
            if (!document.getElementById("cm-float") || !document.getElementById("cm-loc-float")
                || !document.getElementById("cm-consult-float") || !document.getElementById("cm-consult-panel")) {
                try { buildFabAndSheet(); } catch (e) { noteError('watchdog/buildFabAndSheet', e); }
            }
            if (!document.getElementById('cm-wand-entry')) {
                try { buildWandMenuEntry(); } catch (e) { /* menu may not exist yet */ }
            }
            reportDiag();
            if (cmWatchTries >= 60) clearInterval(cmWatch);
        }, 1000);
        reportDiag();
        const et = ctx.eventTypes;
        ctx.eventSource.on(et.MESSAGE_RECEIVED, onMessageReceived);
        ctx.eventSource.on(et.CHAT_CHANGED, onChatChanged);
        if (et.CHARACTER_MESSAGE_RENDERED) ctx.eventSource.on(et.CHARACTER_MESSAGE_RENDERED, () => setTimeout(applyGhostStyles, 0));
        if (et.USER_MESSAGE_RENDERED) ctx.eventSource.on(et.USER_MESSAGE_RENDERED, () => setTimeout(applyGhostStyles, 0));
        if (et.MESSAGE_DELETED) ctx.eventSource.on(et.MESSAGE_DELETED, onChatChanged);
        if (et.MESSAGE_EDITED) ctx.eventSource.on(et.MESSAGE_EDITED, onChatChanged);
        if (et.MESSAGE_SWIPED) ctx.eventSource.on(et.MESSAGE_SWIPED, onChatChanged);
        onChatChanged();
        log('initialized');
    });
}

if (typeof jQuery !== 'undefined' && typeof window !== 'undefined') {
    initCastMemory();
}

// Node export for the logic test harness (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseBlocks, stripBlocks, applyBlock, participantsForRange,
        recomputePresence, parseWriterOutput, emptyStore, getCharacter,
        presentNames, characterNames, entryBoundaries, profileOneLiner,
        cleanModelText, assembleBlock, writeMemoriesForRange, advanceApplied,
        matchCharacterName, normalizeName, extractJsonCandidates, repairJsonStrings,
        rewindLastWrite, unwrapBodyText, renameCharacter, getLocation, locationNames, matchLocationName,
        describeBlock,
        countTextsTotal, ghostTarget, ghostAllNow, refreshExtensionPrompt,
        getTokenCountSource: () => tokenCountSource,
        resetTokenCounterState: () => { tokenFailUntil = 0; tokenCountSource = 'server'; },
        getStore, getSettings, markAppliedMessages, maybeWriteScene,
        getLastInjected: () => lastInjected,
    };
}
