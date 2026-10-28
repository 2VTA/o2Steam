/**
 * o2steam Store: safety review of the Millennium themes.
 *
 * Generated from a read-only scan of each theme repository (files listed, text files read; nothing was run).
 * Reviewed 2026-10-28. A theme that is not in this list has NOT been reviewed and is hidden from the Store.
 *
 *  clean    no network references and nothing executable
 *  network  the theme asks for something outside Steam (hosts listed)
 *  blocked  ships an executable file: hidden from the Store
 */

export type ThemeVerdict = 'clean' | 'network' | 'blocked';

export interface ThemeSafety {
	verdict: ThemeVerdict;
	/** hosts outside Steam the theme's styles or scripts reach for */
	hosts: string[];
	note?: string;
}

export const THEME_SAFETY: Record<string, ThemeSafety> = {
	'1739321142/tsukushiaria-theme': { verdict: 'clean', hosts: [] },
	'aaeriih/umi-asanagi-theme': { verdict: 'clean', hosts: [] },
	'br1rol2/steam2.0-modular': { verdict: 'clean', hosts: [] },
	'dotfelixan/nevko-ui': { verdict: 'network', hosts: ["api.giphy.com", "api.klipy.com", "cdn.jsdelivr.net"], note: "Optional GIF picker (Giphy / Klipy, needs your own API key) and emoji images from jsDelivr." },
	'eugenexxxie/bluearchivesteamskin': { verdict: 'clean', hosts: [] },
	'eyedine2/classic-steam-library': { verdict: 'network', hosts: ["web.archive.org"] },
	'guyonphone/ultrawide': { verdict: 'clean', hosts: [] },
	'hatewxb/aika': { verdict: 'network', hosts: ["api.steamcmd.net"], note: "Looks up game info from steamcmd.net (third-party) while you browse." },
	'ibedro/montblack': { verdict: 'clean', hosts: [] },
	'jonius7/steamui-goldenera': { verdict: 'network', hosts: ["i.imgur.com", "ungstein.github.io"] },
	'kuska1/material-theme': { verdict: 'network', hosts: ["fonts.googleapis.com", "miro.medium.com"] },
	'lil-fluff/no-more-whats-new': { verdict: 'clean', hosts: [] },
	'madmaxgrey/qol-toggles-steam': { verdict: 'clean', hosts: [] },
	'mapleatmorning/oldsteam-theme': { verdict: 'clean', hosts: [] },
	'plaer1/atoms': { verdict: 'clean', hosts: [], note: "Contains developer build scripts (not run by Steam)." },
	'ricewind012/aerothemesteam': { verdict: 'clean', hosts: [] },
	'ricewind012/juxtematic': { verdict: 'network', hosts: ["rawcdn.githack.com"] },
	'ricewind012/win95-themes': { verdict: 'network', hosts: ["rawcdn.githack.com"] },
	'rosetheflower/metrosteam': { verdict: 'network', hosts: ["rosetheflower.github.io"] },
	'saiyajink/minimal-dark-for-steam': { verdict: 'network', hosts: ["fonts.cdnfonts.com"] },
	'sennanon87/aeroxp': { verdict: 'blocked', hosts: [], note: "Ships a stray Windows system DLL (ColorPresets/setupapi.dll). Not loaded by the theme, but it has no business being there." },
	'shdwmtr/simply-dark': { verdict: 'clean', hosts: [] },
	'spacetheme/steam': { verdict: 'network', hosts: ["fonts.googleapis.com", "robertsspaceindustries.com", "spacetheme.net"] },
	'tkashkin/adwaita-for-steam': { verdict: 'clean', hosts: [], note: "Contains developer build scripts (not run by Steam)." },
	'yareli0i/glass-dusk': { verdict: 'clean', hosts: [] },
	'yufengovo/steam-leimu': { verdict: 'clean', hosts: [] },
	'yurisuika/zehn': { verdict: 'clean', hosts: [] },
};

export function themeSafety(owner: string, repo: string): ThemeSafety | undefined {
	return THEME_SAFETY[`${owner}/${repo}`.toLowerCase()];
}
