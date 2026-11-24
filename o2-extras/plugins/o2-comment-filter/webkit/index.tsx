/**
 * o2steam Comment Filter - web part
 *
 * Runs on steamcommunity.com pages. On YOUR OWN profile it adds a small box above the comments where you list
 * words; comments that contain one of them are marked, and you can delete them with one button, or let the filter
 * delete them by itself.
 *
 * It does not talk to Steam's servers on its own: a comment is deleted by pressing the comment's own "delete"
 * link - the same link you would press - so Steam's page does the deleting with your session, exactly as usual.
 * Those links only exist for the owner of the profile, so on anybody else's page nothing can be deleted.
 *
 * What it keeps in this browser (steamcommunity.com storage): your word list, two switches and a short list of
 * what it deleted. Nothing is sent anywhere.
 */

const W = window as any;
const KEY = 'o2steam-comment-filter.v1';
const STEAMID64_BASE = 76561197960265728n;
const PANEL_ID = 'o2cf-panel';
const MARK = 'o2cf-marked';
const MAX_LOG = 12;
const MAX_WORDS = 5000;

interface LogEntry {
	t: number;
	author: string;
	sid?: string; // the author's SteamID64, saved even when the profile has a custom url
	url?: string; // the author's profile (entries from before this existed have none)
	word: string;
	text: string;
}

interface Saved {
	words: string[];
	whole: boolean; // match whole words only ("bot" does not match "robot")
	auto: boolean; // delete without asking
	pending: boolean; // also delete comments Steam is still checking (their text is hidden, so the words can't be read)
	log: LogEntry[];
}

const state = {
	saved: { words: [], whole: true, auto: false, pending: true, log: [] } as Saved,
	busy: false,
	lastCount: -1,
	retryAfter: 0,
};

// ---------------------------------------------------------------- storage

function load() {
	try {
		const p = JSON.parse(localStorage.getItem(KEY) || 'null');
		if (p && typeof p === 'object') {
			state.saved = {
				words: Array.isArray(p.words) ? parseWords(p.words.map((w: any) => (p.v2 ? show(String(w)) : String(w))).join(' ')) : [],
				whole: p.whole !== false,
				auto: !!p.auto,
				pending: p.pending !== false,
				log: Array.isArray(p.log) ? p.log.slice(0, MAX_LOG) : [],
			};
		}
	} catch {}
}

function persist() {
	try {
		localStorage.setItem(KEY, JSON.stringify({ ...state.saved, v2: true }));
	} catch {}
}

// ---------------------------------------------------------------- matching

/** lower case, the same letter shapes, no Arabic marks / stretching */
function norm(text: string): string {
	return String(text ?? '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[ً-ٰٟـ]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findWord(text: string, words: string[], whole: boolean): string | null {
	const hay = norm(text);
	if (!hay) return null;
	for (const raw of words) {
		const w = norm(raw);
		if (!w) continue;
		if (whole) {
			if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'u').test(hay)) return raw;
		} else if (hay.includes(w)) return raw;
	}
	return null;
}

function parseWords(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	// a word is anything between spaces / commas / new lines; text inside "quotes" is one phrase
	const re = /["\u201C\u201D]([^"\u201C\u201D]+)["\u201C\u201D]|[^\s,;\u060C"\u201C\u201D]+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(String(text)))) {
		const w = (m[1] ?? m[0]).trim();
		if (w && !seen.has(norm(w))) {
			seen.add(norm(w));
			out.push(w);
		}
	}
	return out.slice(0, MAX_WORDS);
}

/** how a word is written back into the box (a phrase with spaces gets quotes again) */
const show = (w: string) => (/\s/.test(w) ? `"${w}"`: w);

// ---------------------------------------------------------------- word lists from a file

/** the text of a file, or null when it is not a text file (Word, Excel, PDF, pictures...) */
function decodeBytes(buf: ArrayBuffer): string | null {
	const u8 = new Uint8Array(buf);
	if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2)); // "Unicode" from Notepad
	if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
	const head = u8.subarray(0, Math.min(u8.length, 8000));
	for (let i = 0; i < head.length; i++) if (head[i] === 0) return null; // zero bytes: a binary file
	return new TextDecoder('utf-8').decode(u8).replace(/^\uFEFF/, '');
}

function collectStrings(v: any, out: string[], depth = 0) {
	if (depth > 6) return;
	if (typeof v === 'string') out.push(v);
	else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out, depth + 1));
	else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectStrings(x, out, depth + 1));
}

/**
 * words from a plain-text file of any kind: .txt .csv .tsv .json .md .list .html .xml ... (not Word/Excel/PDF).
 * In text files one LINE is one word or phrase ("buy now" stays together); commas, semicolons and tabs also separate.
 * Lines starting with # // or ; are comments. JSON: every text in it is a word.
 */
function wordsFromFile(name: string, text: string): string[] {
	const ext = (name.split('.').pop() || '').toLowerCase();
	const trimmed = text.trim();
	const raw: string[] = [];

	if (ext === 'json' || /^[\[{]/.test(trimmed)) {
		try {
			collectStrings(JSON.parse(trimmed), raw);
		} catch {}
	}
	if (!raw.length) {
		let body = text;
		if (/^(html?|xml|svg)$/.test(ext) || /^\s*<[a-z!?]/i.test(trimmed)) body = body.replace(/<[^>]*>/g, '\n');
		const lines = body.split(/\r?\n/).filter((l) => !/^\s*(#|\/\/|;)/.test(l));
		const firstCell = (lines[0] || '').split(/[,;\t]/)[0].replace(/["']/g, '').trim();
		if (/^(words?|keywords?|banned|blocked|bad ?words?)$/i.test(firstCell)) lines.shift(); // a column title
		for (const line of lines) {
			const plain = line.replace(/^\s*[-*\u2022]\s+/, ''); // a list bullet ("- word"), not a word like "-rep"
			for (const cell of plain.split(/[,;\t\u060C]/)) raw.push(cell.replace(/^\s*["']|["']\s*$/g, ''));
		}
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of raw) {
		const w = String(r).replace(/\s+/g, ' ').trim();
		if (w && w.length <= 100 && !seen.has(norm(w))) {
			seen.add(norm(w));
			out.push(w);
		}
	}
	return out;
}

// ---------------------------------------------------------------- the page

interface Comment {
	el: HTMLElement;
	id: string;
	text: string;
	author: string;
	authorUrl: string; // the author's profile page ('' if it can't be worked out)
	sid: string; // the author's SteamID64 ('' if unknown)
	link: HTMLAnchorElement | null; // Steam's own delete link (only the profile owner has it)
	own: boolean;
	pending: boolean; // Steam shows "awaiting analysis" instead of the text
}

function ownAccount(): number | null {
	try {
		const id = W.g_steamID;
		if (!id) return null;
		return Number(BigInt(String(id)) - STEAMID64_BASE);
	} catch {
		return null;
	}
}

// Steam hides the text of a comment while its automated content check runs and shows this message instead
const PENDING_RE = /awaiting analysis|content check system|temporarily hidden until/i;
const PENDING_NOTE = '(text hidden by Steam while it checks the comment)';

function readComments(): Comment[] {
	const me = ownAccount();
	return Array.from(document.querySelectorAll<HTMLElement>('.commentthread_comment')).map((el) => {
		const link =
			Array.from(el.querySelectorAll<HTMLAnchorElement>('a')).find((a) => /DeleteComment\s*\(/.test(a.getAttribute('href') || '')) ?? null;
		const mini = Number((el.querySelector('[data-miniprofile]') as HTMLElement | null)?.dataset.miniprofile || 0);
		const href = (el.querySelector('.commentthread_author_link') as HTMLAnchorElement | null)?.href || '';
		let authorUrl = /^https:\/\/steamcommunity\.com\//i.test(href) ? href : '';
		if (!authorUrl && mini) authorUrl = 'https://steamcommunity.com/profiles/' + String(BigInt(mini) + STEAMID64_BASE);
		return {
			el,
			id: el.id,
			authorUrl,
			sid: mini ? String(BigInt(mini) + STEAMID64_BASE) : '',
			text: (el.querySelector('.commentthread_comment_text')?.textContent || '').trim(),
			pending: PENDING_RE.test(el.querySelector('.commentthread_comment_text')?.textContent || ''),
			author: (el.querySelector('.commentthread_author_link')?.textContent || '').trim(),
			link,
			own: me !== null && mini === me,
		};
	});
}

/** comments to delete: a comment Steam is still checking (if that is on), or one that contains a word. Never your own. */
function matches(): { c: Comment; word: string }[] {
	const out: { c: Comment; word: string }[] = [];
	for (const c of readComments()) {
		if (c.own) continue;
		if (c.pending) {
			if (state.saved.pending && c.link) out.push({ c, word: 'Steam was still checking it' });
			continue; // its real text is not known yet
		}
		if (!c.link || !state.saved.words.length) continue;
		const word = findWord(c.text, state.saved.words, state.saved.whole);
		if (word) out.push({ c, word });
	}
	return out;
}

/** a comment Steam is still checking is hidden at once, so its "awaiting analysis" message is not shown while it is deleted */
function hidePending() {
	if (!state.saved.pending) return;
	for (const c of readComments()) if (c.pending && !c.own && c.el.style.display !== 'none') c.el.style.display = 'none';
}

function mark(list: { c: Comment; word: string }[]) {
	document.querySelectorAll<HTMLElement>(`.${MARK}`).forEach((e) => {
		e.classList.remove(MARK);
		e.style.outline = '';
		e.querySelector('.o2cf-tag')?.remove();
	});
	for (const { c, word } of list) {
		c.el.classList.add(MARK);
		c.el.style.outline = '2px solid #e5484d';
		c.el.style.outlineOffset = '2px';
		const tag = document.createElement('div');
		tag.className = 'o2cf-tag';
		tag.textContent = `o2steam Comment Filter: contains "${word}"`;
		tag.style.cssText = 'color:#ff8c8c;font-size:11px;padding:2px 0';
		c.el.querySelector('.commentthread_comment_content')?.appendChild(tag);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (test()) return true;
		await sleep(40);
	}
	return test();
}

/** deletes the matching comments one at a time (Steam redraws the list after each one, so it looks again every time) */
async function deleteMatches(setStatus: (t: string, bad?: boolean) => void): Promise<number> {
	if (state.busy) return 0;
	state.busy = true;
	let done = 0;
	try {
		for (let guard = 0; guard < 60; guard++) {
			const next = matches()[0];
			if (!next) break;
			const { c, word } = next;
			setStatus(`Deleting... (${done + 1})`);
			const id = c.id;
			const el = c.el;
			c.link!.click(); // Steam's own delete link
			const gone = await waitFor(() => !el.isConnected || !document.getElementById(id) || !!document.getElementById(id)?.querySelector('.commentthread_comment_deleted, [class*="deleted"]'), 9000);
			if (!gone) {
				state.retryAfter = Date.now() + 60000; // automatic mode waits a minute before trying again
				setStatus('Steam did not answer to the delete - stopped. Try again in a moment.', true);
				break;
			}
			done++;
			state.saved.log = [{ t: Date.now(), author: c.author || '?', url: c.authorUrl || undefined, sid: c.sid || undefined, word, text: c.pending ? PENDING_NOTE : c.text.slice(0, 80) }, ...state.saved.log].slice(0, MAX_LOG);
			persist();
			await sleep(200); // a short pause between two deletes
		}
	} finally {
		state.busy = false;
	}
	return done;
}

// ---------------------------------------------------------------- the box

const STYLE =
	'margin:0 0 16px;padding:12px 14px;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.18);color:#c6d4df;font-size:13px;line-height:1.5';

let resolveDiag = '';

/** log lines saved before profile links existed: find the person in your own friends list by name and fill the link in */
async function resolveOldLines(): Promise<void> {
	const missing = state.saved.log.filter((l) => !l.url && l.author && l.author !== '?');
	if (!missing.length) return;
	resolveDiag = '';
	try {
		const res = await fetch('https://steamcommunity.com/my/friends/', { credentials: 'include' });
		if (!res.ok) { resolveDiag = 'friends page: HTTP ' + res.status; return; }
		const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
		const friends: { id: string; names: string[] }[] = [];
		doc.querySelectorAll<HTMLElement>('[data-steamid]').forEach((b) => {
			if (!b.classList.contains('friend_block_v2') && !b.querySelector('.friend_block_content')) return;
			const c = (b.querySelector('.friend_block_content') || b).cloneNode(true) as HTMLElement;
			c.querySelectorAll('.friend_small_text, .linkStyle').forEach((e) => e.remove());
			const full = (c.textContent || '').replace(/\s+/g, ' ').trim();
			const names = new Set<string>([norm(full)]);
			const m = full.match(/^(.*?)\s*\((.*)\)\s*$/); // "nickname (real name)"
			if (m) { names.add(norm(m[1])); names.add(norm(m[2])); }
			friends.push({ id: b.dataset.steamid || '', names: [...names].filter(Boolean) });
		});
		resolveDiag = friends.length + ' friends read';
		const clean = (t: string) => norm(t).replace(/[‘’ʼ`´]/g, "'");
		let changed = false;
		for (const l of missing) {
			const parts = new Set<string>([clean(l.author)]);
			const m = l.author.match(/^(.*?)\s*\((.*)\)\s*$/);
			if (m) { parts.add(clean(m[1])); parts.add(clean(m[2])); }
			const wanted = [...parts].filter(Boolean);
			let hit = friends.filter((f) => f.names.some((n) => wanted.includes(clean(n))));
			// a looser try: the friend's name contains the nickname or the real name (3+ letters)
			if (!hit.length) hit = friends.filter((f) => f.names.some((n) => wanted.some((w) => w.length >= 3 && clean(n).includes(w))));
			if (hit.length === 1 && /^\d{17}$/.test(hit[0].id)) {
				l.url = 'https://steamcommunity.com/profiles/' + hit[0].id;
				changed = true;
			} else resolveDiag += hit.length > 1 ? ', ' + hit.length + ' friends match that name' : ', none matches that name';
		}
		if (changed) persist();
	} catch (e) {
		resolveDiag = 'error: ' + String((e as any)?.message || e);
	}
}

function render(panel: HTMLElement, message = '', bad = false) {
	const s = state.saved;
	panel.innerHTML = '';
	const h = (tag: string, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
		const e = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === 'style') e.style.cssText = v;
			else if (k.startsWith('on')) (e as any)[k.toLowerCase()] = v;
			else (e as any)[k] = v;
		}
		for (const k of kids) e.append(k);
		return e;
	};
	const btn = (label: string, onclick: () => void) =>
		h('button', { type: 'button', onclick, style: 'cursor:pointer;background:#2a475e;color:#fff;border:1px solid rgba(255,255,255,0.25);padding:5px 14px;font-size:13px' }, label);

	const status = h('div', { style: 'margin-top:8px;min-height:18px;color:#9ad1ff' });
	status.textContent = message;
	(status as HTMLElement).style.color = bad ? '#ff8c8c' : '#9ad1ff';
	const setStatus = (t: string, bad = false) => {
		status.textContent = t;
		(status as HTMLElement).style.color = bad ? '#ff8c8c' : '#9ad1ff';
	};

	const words = h('textarea', {
		rows: 3,
		placeholder: 'Words to delete comments for: separate them with a space, a comma or a new line. Put "quotes" around a phrase.',
		value: s.words.map(show).join('\n'),
		style: 'width:100%;box-sizing:border-box;background:rgba(0,0,0,0.4);color:#fff;border:1px solid rgba(255,255,255,0.25);padding:6px;font-size:13px;font-family:inherit',
	}) as HTMLTextAreaElement;
	const whole = h('input', { type: 'checkbox', checked: s.whole }) as HTMLInputElement;
	const auto = h('input', { type: 'checkbox', checked: s.auto }) as HTMLInputElement;
	const pending = h('input', { type: 'checkbox', checked: s.pending }) as HTMLInputElement;

	// a list from a file is ADDED to the words you already have
	const importFile = async (f: File) => {
		try {
			const text = decodeBytes(await f.arrayBuffer());
			if (text === null) return setStatus('That file is not plain text (Word, Excel, PDF...). Save the list as .txt or .csv and try again.', true);
			const found = wordsFromFile(f.name, text);
			if (!found.length) return setStatus('No words found in that file. Put one word or phrase per line (commas also work).', true);
			const have = parseWords(words.value);
			const known = new Set(have.map(norm));
			const fresh = found.filter((w) => !known.has(norm(w)));
			const all = [...have, ...fresh].slice(0, MAX_WORDS);
			words.value = all.map(show).join('\n');
			readBack();
			const cut = have.length + fresh.length > MAX_WORDS ? ' (the list is limited to ' + MAX_WORDS + ' words)' : '';
			setStatus('Done - ' + f.name + ': ' + fresh.length + ' new word' + (fresh.length === 1 ? '' : 's') + ' added' + (found.length > fresh.length ? ', ' + (found.length - fresh.length) + ' already in your list' : '') + '. You now have ' + state.saved.words.length + '.' + cut);
			void autoRun();
		} catch (e: any) {
			setStatus('Could not read that file: ' + (e?.message || e), true);
		}
	};
	const chooser = h('input', { type: 'file', style: 'display:none' }) as HTMLInputElement; // no filter: any file
	chooser.onchange = () => {
		const f = chooser.files?.[0];
		chooser.value = '';
		if (f) void importFile(f);
	};
	words.ondragover = (e: DragEvent) => e.preventDefault();
	words.ondrop = (e: DragEvent) => {
		const f = e.dataTransfer?.files?.[0];
		if (!f) return;
		e.preventDefault();
		void importFile(f);
	};

	const readBack = () => {
		state.saved.words = parseWords(words.value);
		state.saved.whole = whole.checked;
		state.saved.auto = auto.checked;
		state.saved.pending = pending.checked;
		persist();
	};

	const check = () => {
		readBack();
		const list = matches();
		mark(list);
		state.lastCount = list.length;
		if (!state.saved.words.length && !state.saved.pending) return setStatus('Add at least one word first.', true);
		if (!list.length) return setStatus('No comment on this page contains your words.');
		setStatus(`${list.length} comment${list.length > 1 ? 's' : ''} on this page contain your words (marked in red).`);
	};

	const doDelete = async () => {
		readBack();
		const n = matches().length;
		if (!n) return setStatus('Nothing to delete on this page.');
		const done = await deleteMatches(setStatus);
		mark(matches());
		render(panel, done ? `Done - ${done} comment${done > 1 ? 's' : ''} deleted.` : 'Nothing was deleted.', !done);
	};

	panel.append(
		h('div', { style: 'font-weight:600;color:#fff;margin-bottom:6px' }, 'o2steam Comment Filter'),
		words,
		h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap' }, btn('Add words from a file...', () => chooser.click()), chooser, h('span', { style: 'font-size:12px;opacity:0.7' }, 'any text file: .txt .csv .json ... one word or phrase per line (or drop the file on the box)')),
		h('label', { style: 'display:block;margin-top:6px' }, whole, ' Match whole words only (so "bot" does not catch "robot")'),
		h('label', { style: 'display:block' }, auto, ' Delete matching comments automatically, without asking'),
		h('label', { style: 'display:block' }, pending, ' Delete comments that Steam is still checking (Steam hides their text, so words cannot be read) - they are hidden at once'),
		h('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' }, btn('Save words', () => { readBack(); setStatus(state.saved.words.length ? `Saved ${state.saved.words.length} word${state.saved.words.length === 1 ? '' : 's'}: ${state.saved.words.map(show).join('  |  ')}` : 'No words saved.'); void autoRun(); }), btn('Check this page', check), btn('Delete the matching comments', doDelete)),
		status,
	);

	if (s.log.length) {
		const log = h('div', { style: 'margin-top:10px;font-size:12px;opacity:0.8' }, h('div', { style: 'font-weight:600' }, 'Deleted by the filter'));
		for (const l of s.log) {
			// the name is a link to that person's profile (only our own steamcommunity.com links are accepted)
			const who = l.url && /^https:\/\/steamcommunity\.com\//i.test(l.url)
				? h('a', { href: l.url, style: 'color:inherit;text-decoration:underline;cursor:pointer', title: 'Open this profile' }, l.author)
				: l.author && l.author !== '?'
					// older lines have no saved profile link: the name opens Steam's people search instead
					? h('a', {
							href: '#',
							style: 'color:inherit;text-decoration:underline;cursor:pointer',
							title: 'Open this profile (looked up in your friends list)',
							onclick: (ev: Event) => {
								ev.preventDefault();
								setStatus('Looking for ' + l.author + ' in your friends list...');
								void resolveOldLines().then(() => {
									if (l.url) location.href = l.url;
									else setStatus('Could not find "' + l.author + '" in your friends list, and this line was saved without a profile link (' + (resolveDiag || 'no details') + ').', true);
								});
							},
						}, l.author)
					: h('span', {}, l.author);
			const sid = l.sid || (l.url || '').match(/\/profiles\/(\d{17})/)?.[1] || '';
			const idTag = sid
				? h('span', { style: 'user-select:text;opacity:0.75' }, ' [Steam ID ' + sid + ']')
				: h('span', { style: 'opacity:0.5' }, ' [no Steam ID saved: deleted before this was added]');
			log.append(h('div', {}, `${new Date(l.t).toLocaleString()} - `, who, idTag, `: "${l.text}" (${l.word})`));
		}
		panel.append(log);
	}
}

function mountPanel(): HTMLElement | null {
	let panel = document.getElementById(PANEL_ID);
	if (panel && panel.isConnected) return panel;
	const area = document.querySelector<HTMLElement>('.commentthread_area, [id^="commentthread_Profile"], .profile_comment_area');
	if (!area || !area.parentElement) return null;
	panel = document.createElement('div');
	panel.id = PANEL_ID;
	panel.style.cssText = STYLE;
	area.parentElement.insertBefore(panel, area);
	render(panel);
	return panel;
}

async function autoRun() {
	if (!state.saved.auto || state.busy || Date.now() < state.retryAfter) return;
	if (!matches().length) return;
	const panel = document.getElementById(PANEL_ID);
	const done = await deleteMatches(() => {});
	if (panel && done) render(panel, `Done - ${done} comment${done > 1 ? 's' : ''} deleted automatically.`);
}

export default async function WebkitMain() {
	if (!location.hostname.endsWith('steamcommunity.com')) return;
	if (!/^\/(id|profiles)\/[^/]+\/?$/.test(location.pathname)) return; // profile pages only
	load();

	// it must be YOUR profile. (A visitor also gets a delete link on his own comment on someone else's page, so a
	// delete link alone is not proof; it is only used when the page's own ids can't be read at all.)
	const ownerPage = () => {
		const idsKnown = W.g_steamID !== undefined && !!W.g_rgProfileData;
		return idsKnown ? !!W.g_steamID && String(W.g_steamID) === String(W.g_rgProfileData.steamid) : readComments().some((c) => c.link);
	};

	let timer: any = 0;
	const run = () => {
		try {
			// only the owner has delete links; on other profiles nothing is shown at all
			if (!ownerPage()) return;
			hidePending();
			if (!mountPanel()) return;
			void autoRun();
		} catch {}
	};
	const observer = new MutationObserver(() => {
		try {
			if (ownerPage()) hidePending(); // no waiting: the "awaiting analysis" message must not show
		} catch {}
		clearTimeout(timer);
		timer = setTimeout(run, 120);
	});
	const start = () => {
		if (!document.body) return void setTimeout(start, 200);
		observer.observe(document.body, { childList: true, subtree: true });
		run();
	};
	start();
}
