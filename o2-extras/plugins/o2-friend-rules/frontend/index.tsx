/**
 * o2steam Friend Rules
 *
 * Your own rules for incoming friend requests, checked in order: the first rule that matches decides
 * (accept / ignore / block / leave it). It runs inside the Steam client, so it works without having Steam
 * open in a browser, and it uses Steam's own friend functions - the same ones the Accept / Ignore / Block
 * buttons in the friends list call:
 *   accept = FriendStore.SendFriendInvite, ignore = FriendStore.RemoveFriend, block = FriendStore.BlockPlayer
 *
 * Where the facts come from (Steam only, nothing else):
 *   name, mutual friends ...... Steam's friend store (it loads mutual friends for incoming requests itself)
 *   Steam level ............... steamcommunity.com/miniprofile/<accountid>/json (Steam allows this from here)
 *   privacy, country .......... steamcommunity.com/profiles/<steamid>/?xml=1      (read by o2steam's core)
 *   CS2 inventory + value ..... steamcommunity.com/inventory/<steamid>/730/2       (read by o2steam's core)
 *                               + Steam market prices (priceoverview, cached, slow on purpose)
 * A fact that can't be read makes its rule not match, so the next rule is checked.
 */

declare const g_FriendsUIApp: any;

const W = window as any;
const STORAGE_KEY = 'o2steam-friend-rules.v1';
const PRICE_KEY = 'o2steam-friend-rules.prices.v1';
const STEAMID64_BASE = 76561197960265728n;
const DAY = 24 * 60 * 60 * 1000;
const PRICE_TTL = 12 * 60 * 60 * 1000;
const PRICE_GAP_MS = 3500; // Steam's market answers ~20 price requests a minute
const MAX_PRICED_ITEMS = 30; // per person, items not already in the price cache
const POLL_MS = 8000;

type CondId =
	| 'profile_private'
	| 'profile_public'
	| 'from_country'
	| 'steam_level_under'
	| 'steam_level_over'
	| 'cs2_value_over'
	| 'cs2_value_under'
	| 'inventory_private'
	| 'common_friends_over'
	| 'common_friends_under'
	| 'name_includes'
	| 'repeated_request'
	| 'all_users';
type ActionId = 'accept' | 'ignore' | 'block' | 'none';

interface Rule {
	id: string;
	cond: CondId;
	value: string;
	action: ActionId;
	on: boolean;
}

interface LogEntry {
	t: number;
	name: string;
	accountid: number;
	rule: string;
	action: ActionId;
	result: string;
}

interface Saved {
	enabled: boolean;
	rules: Rule[];
	pending: Record<string, number>; // accountid -> when we first saw this request
	history: Record<string, number[]>; // accountid -> when requests from them arrived
	log: LogEntry[];
}

const CONDITIONS: { id: CondId; label: string; value?: 'number' | 'text'; hint?: string; describe: (v: string) => string }[] = [
	{ id: 'profile_private', label: 'Private profile', describe: () => 'Private profile' },
	{ id: 'profile_public', label: 'Public profile', describe: () => 'Public profile' },
	{ id: 'from_country', label: 'From country', value: 'text', hint: 'e.g. Saudi Arabia (several: comma between)', describe: (v) => `From country: ${v}` },
	{ id: 'steam_level_under', label: 'Steam level under', value: 'number', hint: 'level (this number counts too)', describe: (v) => `Steam level ${v} or under` },
	{ id: 'steam_level_over', label: 'Steam level over', value: 'number', hint: 'level', describe: (v) => `Steam level over ${v}` },
	{ id: 'cs2_value_over', label: 'CS2 inventory value over', value: 'number', hint: 'USD, Steam market', describe: (v) => `CS2 inventory over $${v}` },
	{ id: 'cs2_value_under', label: 'CS2 inventory value under', value: 'number', hint: 'USD, Steam market', describe: (v) => `CS2 inventory $${v} or under` },
	{ id: 'inventory_private', label: 'Private inventory', describe: () => 'Private inventory' },
	{ id: 'common_friends_over', label: 'Common friends more than', value: 'number', hint: 'friends', describe: (v) => `Common friends more than ${v}` },
	{ id: 'common_friends_under', label: 'Common friends same or less than', value: 'number', hint: 'friends', describe: (v) => `Common friends ${v} or less` },
	{ id: 'name_includes', label: 'Username includes', value: 'text', hint: 'text, e.g. BOT', describe: (v) => `Username includes "${v}"` },
	{ id: 'repeated_request', label: 'Repeated friend request', describe: () => 'Repeated friend request (within a week)' },
	{ id: 'all_users', label: 'All users', describe: () => 'All users' },
];

const ACTIONS: { id: ActionId; label: string }[] = [
	{ id: 'accept', label: 'Accept' },
	{ id: 'ignore', label: 'Ignore' },
	{ id: 'block', label: 'Block' },
	{ id: 'none', label: 'No action' },
];

const newId = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_RULES: Rule[] = [
	{ id: newId(), cond: 'steam_level_under', value: '5', action: 'ignore', on: true },
	{ id: newId(), cond: 'common_friends_over', value: '5', action: 'accept', on: false },
	{ id: newId(), cond: 'profile_private', value: '', action: 'ignore', on: false },
	{ id: newId(), cond: 'name_includes', value: 'BOT', action: 'ignore', on: false },
	{ id: newId(), cond: 'repeated_request', value: '', action: 'block', on: false },
];

const state = {
	saved: { enabled: false, rules: DEFAULT_RULES, pending: {}, history: {}, log: [] } as Saved,
	handled: new Set<number>(), // requests already decided in this Steam session
	busy: false,
	preview: null as null | { name: string; result: string }[],
	previewRunning: false,
	listeners: new Set<() => void>(),
};

// ---------------------------------------------------------------- storage

function loadSaved() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			state.saved = {
				enabled: !!parsed.enabled,
				rules: Array.isArray(parsed.rules) ? parsed.rules.filter((r: any) => CONDITIONS.some((c) => c.id === r?.cond) && ACTIONS.some((a) => a.id === r?.action)) : DEFAULT_RULES,
				pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
				history: parsed.history && typeof parsed.history === 'object' ? parsed.history : {},
				log: Array.isArray(parsed.log) ? parsed.log.slice(0, 60) : [],
			};
		}
	} catch {}
}

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved));
	} catch {}
}

function notify() {
	state.listeners.forEach((l) => l());
}

let priceCache: Record<string, { p: number | null; t: number }> = {};
function loadPrices() {
	try {
		priceCache = JSON.parse(localStorage.getItem(PRICE_KEY) || '{}') || {};
		const now = Date.now();
		for (const k of Object.keys(priceCache)) if (now - priceCache[k].t > PRICE_TTL) delete priceCache[k];
	} catch {
		priceCache = {};
	}
}
function savePrices() {
	try {
		localStorage.setItem(PRICE_KEY, JSON.stringify(priceCache));
	} catch {}
}

// ---------------------------------------------------------------- Steam access

const friendStore = () => g_FriendsUIApp?.m_FriendStore;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function incomingIds(): number[] {
	try {
		return Array.from(friendStore()?.m_setIncomingInviteAccountIDs ?? []).map(Number).filter((n) => n > 0);
	} catch {
		return [];
	}
}

/** body + HTTP status (0 when the core couldn't say) read by o2steam's core; null when it failed */
async function coreFetchFull(url: string): Promise<{ body: string; status: number } | null> {
	try {
		const result: any = await W.MILLENNIUM_API.ffi('core', 'Core_FetchStoreJson')(url);
		return result?.success ? { body: String(result.body ?? ''), status: Number(result.status ?? 0) } : null;
	} catch {
		return null;
	}
}

async function coreFetch(url: string): Promise<string | null> {
	const r = await coreFetchFull(url);
	return r && (r.status === 0 || r.status === 200) ? r.body : null;
}

/** everything we learn about one person, read only when a rule needs it */
class Person {
	accountid: number;
	steamid: string;
	private cache = new Map<string, Promise<any>>();

	constructor(accountid: number) {
		this.accountid = accountid;
		this.steamid = (STEAMID64_BASE + BigInt(accountid)).toString();
	}

	private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
		if (!this.cache.has(key)) this.cache.set(key, fn().catch(() => null));
		return this.cache.get(key);
	}

	player() {
		try {
			return friendStore()?.GetPlayer(this.accountid);
		} catch {
			return null;
		}
	}

	name(): string {
		const p = this.player();
		return String(p?.persona?.m_strPlayerName || p?.display_name || this.accountid);
	}

	level(): Promise<number | null> {
		return this.once('level', async () => {
			const r = await fetch(`https://steamcommunity.com/miniprofile/${this.accountid}/json`);
			const j = await r.json();
			return typeof j?.level === 'number' ? j.level : null;
		});
	}

	/** { privacy: 'public' | 'friendsonly' | 'private', country: string } */
	profile(): Promise<{ privacy: string; country: string } | null> {
		return this.once('profile', async () => {
			const xml = await coreFetch(`https://steamcommunity.com/profiles/${this.steamid}/?xml=1`);
			if (!xml) return null;
			const doc = new DOMParser().parseFromString(xml, 'text/xml');
			if (doc.querySelector('error')) return { privacy: 'private', country: '' }; // profile not set up
			const privacy = (doc.querySelector('privacyState')?.textContent || '').trim().toLowerCase();
			if (!privacy) return null;
			const location = (doc.querySelector('location')?.textContent || '').trim();
			const country = location.split(',').pop()?.trim() || '';
			return { privacy, country };
		});
	}

	/** null = could not read; { private: true } = hidden inventory */
	inventory(): Promise<{ private: boolean; items: { name: string; count: number }[] } | null> {
		return this.once('inventory', async () => {
			const r = await coreFetchFull(`https://steamcommunity.com/inventory/${this.steamid}/730/2?l=english&count=2000`);
			if (!r) return null;
			// Steam says 403 for a hidden inventory; 429 (too many requests) and the rest mean "don't know",
			// so a "Private inventory -> Block" rule never fires just because Steam was busy
			if (r.status === 403 || r.status === 401) return { private: true, items: [] };
			if (r.status !== 200) return null;
			const trimmed = r.body.trim();
			if (trimmed === '' || trimmed === 'null') return null;
			let j: any;
			try {
				j = JSON.parse(trimmed);
			} catch {
				return null; // rate limited / html error page
			}
			if (!j || j.success === false || j.success === 0) return null;
			const names = new Map<string, string>();
			for (const d of j.descriptions ?? []) if (d.marketable) names.set(`${d.classid}_${d.instanceid}`, d.market_hash_name);
			const counts = new Map<string, number>();
			for (const a of j.assets ?? []) {
				const n = names.get(`${a.classid}_${a.instanceid}`);
				if (n) counts.set(n, (counts.get(n) ?? 0) + Number(a.amount || 1));
			}
			const items = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
			return { private: false, items };
		});
	}

	/** CS2 inventory value in USD from Steam market prices. Stops early once `stopAbove` is passed. */
	async cs2Value(stopAbove = Infinity): Promise<{ value: number; complete: boolean } | null> {
		const inv = await this.inventory();
		if (!inv || inv.private) return null;
		let value = 0;
		let lookups = 0;
		let complete = true;
		for (const item of inv.items) {
			let price = cachedPrice(item.name);
			if (price === undefined) {
				if (lookups >= MAX_PRICED_ITEMS) {
					complete = false;
					break;
				}
				lookups++;
				price = await fetchPrice(item.name);
			}
			if (price) value += price * item.count;
			if (value > stopAbove) return { value, complete: false };
		}
		return { value, complete };
	}

	/** how many friends you share, from Steam's own list for incoming requests */
	mutualFriends(): Promise<number | null> {
		return this.once('mutual', async () => {
			const groups = friendStore()?.m_FriendGroupStore;
			if (!groups) return null;
			try {
				groups.EnsureMutualFriendsForIncomingInvites();
			} catch {}
			for (let i = 0; i < 12; i++) {
				const count = readMutual(groups, this);
				if (count !== null) return count;
				await sleep(500);
			}
			return null;
		});
	}
}

function readMutual(groups: any, person: Person): number | null {
	const map = groups?.m_groupIncomingInvites?.m_mapSteamIDToMutualFriends ?? groups?.incoming_invites_group?.m_mapSteamIDToMutualFriends;
	if (!map) return null;
	const size = typeof map.size === 'number' ? map.size : Object.keys(map).length;
	if (!size) return null;
	const get = (key: any) => (typeof map.get === 'function' ? map.get(key) : map[key]);
	let value = get(person.steamid) ?? get(String(person.accountid)) ?? get(person.accountid);
	if (value === undefined && typeof map.forEach === 'function') {
		map.forEach((v: any, k: any) => {
			const ks = typeof k?.ConvertTo64BitString === 'function' ? k.ConvertTo64BitString() : String(k);
			if (ks === person.steamid || ks === String(person.accountid)) value = v;
		});
	}
	if (value === undefined) return 0; // Steam loaded the list and this person shares nobody
	if (Array.isArray(value)) return value.length;
	if (typeof value?.length === 'number') return value.length;
	if (typeof value?.size === 'number') return value.size;
	if (typeof value === 'number') return value;
	return null;
}

function cachedPrice(name: string): number | null | undefined {
	const hit = priceCache[name];
	if (hit && Date.now() - hit.t < PRICE_TTL) return hit.p;
	return undefined;
}

let lastPriceAt = 0;
async function fetchPrice(name: string): Promise<number | null> {
	const wait = lastPriceAt + PRICE_GAP_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastPriceAt = Date.now();
	const body = await coreFetch(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(name)}`);
	let price: number | null = null;
	try {
		const j = JSON.parse(body ?? '');
		const text = String(j?.lowest_price || j?.median_price || '');
		const n = parseFloat(text.replace(/[^0-9.]/g, ''));
		price = isFinite(n) ? n : null;
	} catch {
		return null; // don't cache a failed / rate-limited answer
	}
	priceCache[name] = { p: price, t: Date.now() };
	savePrices();
	return price;
}

// ---------------------------------------------------------------- rules

const num = (v: string) => {
	const n = parseFloat(String(v).replace(',', '.'));
	return isFinite(n) ? n : NaN;
};

function isRepeated(accountid: number): boolean {
	const times = state.saved.history[String(accountid)] ?? [];
	const current = state.saved.pending[String(accountid)];
	return times.some((t) => t !== current && current - t < 7 * DAY && current >= t);
}

async function matches(rule: Rule, p: Person): Promise<boolean> {
	switch (rule.cond) {
		case 'all_users':
			return true;
		case 'name_includes': {
			const needle = rule.value.trim().toLowerCase();
			return !!needle && p.name().toLowerCase().includes(needle);
		}
		case 'repeated_request':
			return isRepeated(p.accountid);
		case 'steam_level_under': {
			const lvl = await p.level();
			return lvl !== null && !isNaN(num(rule.value)) && lvl <= num(rule.value);
		}
		case 'steam_level_over': {
			const lvl = await p.level();
			return lvl !== null && !isNaN(num(rule.value)) && lvl > num(rule.value);
		}
		case 'profile_private': {
			const pr = await p.profile();
			return !!pr && pr.privacy !== 'public';
		}
		case 'profile_public': {
			const pr = await p.profile();
			return !!pr && pr.privacy === 'public';
		}
		case 'from_country': {
			const pr = await p.profile();
			if (!pr?.country) return false;
			const wanted = rule.value.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
			return wanted.includes(pr.country.toLowerCase());
		}
		case 'inventory_private': {
			const inv = await p.inventory();
			return !!inv && inv.private;
		}
		case 'cs2_value_over': {
			const limit = num(rule.value);
			if (isNaN(limit)) return false;
			const v = await p.cs2Value(limit);
			return !!v && v.value > limit;
		}
		case 'cs2_value_under': {
			const limit = num(rule.value);
			if (isNaN(limit)) return false;
			const v = await p.cs2Value(limit);
			return !!v && v.value <= limit; // over 30 unpriced items: the value of the most common ones
		}
		case 'common_friends_over': {
			const c = await p.mutualFriends();
			return c !== null && !isNaN(num(rule.value)) && c > num(rule.value);
		}
		case 'common_friends_under': {
			const c = await p.mutualFriends();
			return c !== null && !isNaN(num(rule.value)) && c <= num(rule.value);
		}
	}
	return false;
}

function describe(rule: Rule): string {
	return CONDITIONS.find((c) => c.id === rule.cond)?.describe(rule.value) ?? rule.cond;
}

async function decide(p: Person): Promise<Rule | null> {
	for (const rule of state.saved.rules) {
		if (!rule.on) continue;
		if (await matches(rule, p)) return rule;
	}
	return null;
}

async function act(p: Person, action: ActionId): Promise<string> {
	if (action === 'none') return 'left as is';
	if (!incomingIds().includes(p.accountid)) return 'request already gone';
	const fs = friendStore();
	const player = p.player();
	if (!fs || !player) return 'could not reach Steam friends';
	try {
		if (action === 'accept') await fs.SendFriendInvite(player);
		else if (action === 'ignore') await fs.RemoveFriend(player);
		else if (action === 'block') await fs.BlockPlayer(player);
		return 'done';
	} catch (e: any) {
		return 'failed: ' + String(e?.message ?? e);
	}
}

function addLog(entry: LogEntry) {
	state.saved.log = [entry, ...state.saved.log].slice(0, 60);
	persist();
	notify();
}

/** keeps track of when requests arrived (for "repeated") and handles new ones */
async function tick() {
	const ids = incomingIds();
	const now = Date.now();
	let changed = false;
	for (const id of ids) {
		const key = String(id);
		if (!state.saved.pending[key]) {
			state.saved.pending[key] = now;
			state.saved.history[key] = [...(state.saved.history[key] ?? []), now].filter((t) => now - t < 30 * DAY).slice(-10);
			changed = true;
		}
	}
	for (const key of Object.keys(state.saved.pending)) {
		if (!ids.includes(Number(key))) {
			delete state.saved.pending[key];
			state.handled.delete(Number(key));
			changed = true;
		}
	}
	for (const key of Object.keys(state.saved.history)) {
		state.saved.history[key] = state.saved.history[key].filter((t) => now - t < 30 * DAY);
		if (!state.saved.history[key].length) delete state.saved.history[key];
	}
	if (changed) persist();

	if (!state.saved.enabled || state.busy) return;
	const todo = ids.filter((id) => !state.handled.has(id));
	if (!todo.length) return;
	state.busy = true;
	try {
		for (const id of todo) {
			if (!state.saved.enabled) break;
			state.handled.add(id);
			const p = new Person(id);
			const rule = await decide(p);
			if (!rule) continue;
			const result = await act(p, rule.action);
			addLog({ t: Date.now(), name: p.name(), accountid: id, rule: describe(rule), action: rule.action, result });
		}
	} finally {
		state.busy = false;
	}
}

async function runPreview() {
	state.previewRunning = true;
	state.preview = [];
	notify();
	for (const id of incomingIds()) {
		const p = new Person(id);
		const rule = await decide(p);
		state.preview.push({ name: p.name(), result: rule ? `${ACTIONS.find((a) => a.id === rule.action)?.label} - ${describe(rule)}` : 'no rule matches (left as is)' });
		notify();
	}
	state.previewRunning = false;
	notify();
}

// ---------------------------------------------------------------- settings panel (no JSX: Steam's React is used directly)

const css = {
	muted: { fontSize: 12, opacity: 0.75, lineHeight: '17px' },
	table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
	th: { textAlign: 'left', padding: '6px 6px', fontWeight: 600, opacity: 0.85, borderBottom: '1px solid rgba(255,255,255,0.12)' },
	td: { padding: '6px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', verticalAlign: 'middle' },
	arrow: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14, padding: '0 4px' },
	input: { background: 'rgba(0,0,0,0.35)', color: 'inherit', border: '1px solid rgba(255,255,255,0.2)', padding: '5px 6px', fontSize: 13, fontFamily: 'inherit' },
	pill: (on: boolean) => ({ cursor: 'pointer', border: '1px solid rgba(255,255,255,0.25)', background: on ? 'rgba(26,159,255,0.85)' : 'rgba(255,255,255,0.08)', color: '#fff', padding: '3px 12px', fontSize: 12, minWidth: 48 }),
};

function Panel() {
	const React = W.SP_REACT;
	const { DialogButton, Field, PanelSection, PanelSectionRow, Toggle } = W.MILLENNIUM_API;
	const [, force] = React.useReducer((x: number) => x + 1, 0);
	const [newCond, setNewCond] = React.useState('inventory_private' as CondId);
	const [newValue, setNewValue] = React.useState('');
	const [newAction, setNewAction] = React.useState('ignore' as ActionId);
	const [message, setMessage] = React.useState('');

	React.useEffect(() => {
		state.listeners.add(force);
		return () => {
			state.listeners.delete(force);
		};
	}, []);

	const h = React.createElement;
	const rules = state.saved.rules;

	const save = (next: Rule[]) => {
		state.saved.rules = next;
		state.handled.clear(); // rules changed: look at waiting requests again
		persist();
		force();
	};
	const move = (i: number, d: number) => {
		const next = [...rules];
		const [r] = next.splice(i, 1);
		next.splice(i + d, 0, r);
		save(next);
	};
	const update = (i: number, patch: Partial<Rule>) => save(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	const remove = (i: number) => save(rules.filter((_, j) => j !== i));
	const add = () => {
		const def = CONDITIONS.find((c) => c.id === newCond);
		if (def?.value && !newValue.trim()) return setMessage(`"${def.label}" needs a value.`);
		if (def?.value === 'number' && isNaN(num(newValue))) return setMessage('Use a number for that one.');
		save([...rules, { id: newId(), cond: newCond, value: def?.value ? newValue.trim() : '', action: newAction, on: true }]);
		setNewValue('');
		setMessage('');
	};
	const setEnabled = (on: boolean) => {
		state.saved.enabled = on;
		state.handled.clear();
		persist();
		force();
		if (on) void tick();
	};

	const newDef = CONDITIONS.find((c) => c.id === newCond);
	const actionLabel = (a: ActionId) => ACTIONS.find((x) => x.id === a)?.label ?? a;

	return h(
		PanelSection,
		{ title: 'o2steam Friend Rules' },
		h(Field, { label: 'Automatically process friend requests', description: 'Off = nothing happens to your requests.' }, h(Toggle, { value: state.saved.enabled, onChange: setEnabled })),
		h(
			PanelSectionRow,
			null,
			h(
				'div',
				{ style: css.muted },
				'Rules are checked in order - the action of the first matching rule is used. This runs inside Steam, so it works without a browser. ',
				'Facts come only from Steam (profile, level, inventory, Steam market prices). If something can\'t be read, that rule is skipped.',
			),
		),
		h(
			'table',
			{ style: css.table },
			h('thead', null, h('tr', null, h('th', { style: { ...css.th, width: 56 } }, 'Order'), h('th', { style: css.th }, 'Condition'), h('th', { style: css.th }, 'Action'), h('th', { style: css.th }, 'State'), h('th', { style: css.th }, ''))),
			h(
				'tbody',
				null,
				rules.map((r, i) =>
					h(
						'tr',
						{ key: r.id, style: { opacity: r.on ? 1 : 0.55 } },
						h(
							'td',
							{ style: css.td },
							i > 0 ? h('button', { style: css.arrow, title: 'Up', onClick: () => move(i, -1) }, '▲') : h('span', { style: { display: 'inline-block', width: 22 } }),
							i < rules.length - 1 ? h('button', { style: css.arrow, title: 'Down', onClick: () => move(i, 1) }, '▼') : null,
						),
						h('td', { style: css.td }, describe(r)),
						h(
							'td',
							{ style: css.td },
							h(
								'select',
								{ style: css.input, value: r.action, onChange: (e: any) => update(i, { action: e.target.value }) },
								ACTIONS.map((a) => h('option', { key: a.id, value: a.id }, a.label)),
							),
						),
						h('td', { style: css.td }, h('button', { style: css.pill(r.on), onClick: () => update(i, { on: !r.on }) }, r.on ? 'ON' : 'OFF')),
						h('td', { style: css.td }, h('button', { style: { ...css.arrow, fontSize: 16 }, title: 'Delete', onClick: () => remove(i) }, '✕')),
					),
				),
			),
		),
		h(
			'div',
			{ style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 } },
			h('span', { style: { fontSize: 18, opacity: 0.8 } }, '+'),
			h(
				'select',
				{ style: css.input, value: newCond, onChange: (e: any) => setNewCond(e.target.value) },
				CONDITIONS.map((c) => h('option', { key: c.id, value: c.id }, c.label)),
			),
			newDef?.value
				? h('input', { style: { ...css.input, width: 170 }, value: newValue, placeholder: newDef.hint ?? '', inputMode: newDef.value === 'number' ? 'decimal' : 'text', onChange: (e: any) => setNewValue(e.target.value) })
				: null,
			h(
				'select',
				{ style: css.input, value: newAction, onChange: (e: any) => setNewAction(e.target.value) },
				ACTIONS.map((a) => h('option', { key: a.id, value: a.id }, a.label)),
			),
			h(DialogButton, { style: { width: 'auto', minWidth: 90, padding: '4px 16px' }, onClick: add }, 'Add rule'),
		),
		message ? h(PanelSectionRow, null, h('div', { style: { fontSize: 12, color: '#ffb35c', marginTop: 6 } }, message)) : null,
		h(
			'div',
			{ style: { display: 'flex', gap: 8, marginTop: 16 } },
			h(
				DialogButton,
				{ style: { width: 'auto', padding: '4px 16px' }, disabled: state.previewRunning, onClick: () => void runPreview() },
				state.previewRunning ? 'Checking...' : `Check waiting requests (${incomingIds().length}) - no action`,
			),
			state.saved.log.length
				? h(DialogButton, { style: { width: 'auto', padding: '4px 16px' }, onClick: () => { state.saved.log = []; persist(); force(); } }, 'Clear history')
				: null,
		),
		state.preview
			? h(
					'div',
					{ style: { ...css.muted, marginTop: 8 } },
					state.preview.length ? state.preview.map((p, i) => h('div', { key: i }, `${p.name}: ${p.result}`)) : 'No waiting friend requests.',
			  )
			: null,
		h('div', { style: { fontWeight: 600, marginTop: 18, marginBottom: 4 } }, 'History'),
		state.saved.log.length
			? h(
					'div',
					{ style: css.muted },
					state.saved.log.map((l, i) =>
						h('div', { key: i }, `${new Date(l.t).toLocaleString()} - ${l.name}: ${actionLabel(l.action)} (${l.rule}) - ${l.result}`),
					),
			  )
			: h('div', { style: css.muted }, 'Nothing handled yet.'),
	);
}

export default async function PluginMain() {
	loadSaved();
	loadPrices();
	setInterval(() => void tick(), POLL_MS);
	setTimeout(() => void tick(), 4000);

	return {
		title: 'o2steam Friend Rules',
		icon: W.SP_REACT.createElement('span', null, 'o2'),
		content: W.SP_REACT.createElement(Panel),
	};
}
