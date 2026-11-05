/*
 * Google Calendar — two-way sync between Google Calendar and a Thymer collection.
 * Copyright (c) 2026 Parham Shafti. All rights reserved. Use is free; modifying,
 * redistributing or building on this code is not allowed. See LICENSE.
 *
 * Every synced event is a page in one collection ("Calendar Events"). The page
 * TITLE is yours: it is seeded from Google once and never overwritten (the live
 * Google title lives in the "Google Title" property). Attendees are linked to
 * pages in a people collection of your choice, matched by e-mail, then by name,
 * and created when missing.
 *
 * Sign-in: OAuth 2.0 with PKCE. The browser comes back through a tiny hosted
 * page that forwards to thymer://<host>/plugin-action?action=gcal-oauth, which
 * Thymer hands to us via window.thymerDesktopAPI.onProtocolAction. In the web
 * client the same page posts the code back to the opener window instead.
 *
 * Only a rolling window of events is ever fetched (pastDays / futureDays), so
 * history never floods the collection.
 */

const GC_CLIENT_ID = '1047166243922-l7oue40krgd2l3i4iil4g15bgr416mqq.apps.googleusercontent.com';
/* Google requires the client secret at the token endpoint even with PKCE, and
 * a secret shipped in plugin code is no secret. So token requests for the
 * built-in client go through our relay (relay/), which adds it. A user's own
 * Google Cloud client (Settings → Advanced) still talks to Google directly. */
const GC_TOKEN_RELAY = 'https://thymer-calendar.anlet-studies.workers.dev/google/token';
const GC_REDIRECT_URI = 'https://calendar.anlet.se/oauth/';
/* The narrowest pair that covers the plugin: events on every calendar, plus the
 * calendar list. The full auth/calendar scope ("share and permanently delete all
 * calendars") was never needed and weighs on Google's review. */
const GC_SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const GC_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GC_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GC_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GC_API = 'https://www.googleapis.com/calendar/v3';
const GC_ACTION = 'gcal-oauth';

/* Debug hooks (window.__gcal*, the gcal_log ring) exist only with
 * localStorage gcal_dev = '1': the dev tools in tools/ set it. */
const GC_DEV = (() => { try { return window.localStorage.getItem('gcal_dev') === '1'; } catch (e) { return false; } })();
const LS_SETTINGS = 'gcal_settings';
const LS_TOKENS = 'gcal_tokens';
const LS_STATE = 'gcal_state';
const LS_PENDING = 'gcal_pending';
const LS_REOPEN = 'gcal_reopen';
const LS_PLACEBIAS = 'gcal_placebias';
const LS_RELEASEQ = 'gcal_releaseq';
/* Geoapify Autocomplete (free plan: no card, blocks instead of charging).
 * The key only works from *.thymer.com origins; if it is ever throttled or
 * blocked, place suggestions fall back to Photon. */
const GC_GEOAPIFY_KEY = 'c92796b0572d4c8b9758d96f9bfdf01c';

const GC_DEFAULTS = {
	collectionGuid: null,
	collectionName: 'Calendar',
	calendars: {},          // id -> { enabled, summary, accessRole, color }
	pastDays: 14,
	futureDays: 90,
	pollMinutes: 5,
	persons: { collectionGuid: null, emailField: '', createMissing: true },
	descHeading: 'Description',
	createInGoogle: true,   // new pages with a date + Calendar become Google events
	/* The one date property: 'when' (When) or 'due' (Due Date, the name
	 * Supertask and other collections use, so a moved page keeps its date). */
	dateField: 'when',
	/* Status: the built-in Confirmed/Cancelled choice, or a linked-record property
	 * pointing at the user's own status collection (e.g. Action Status), with
	 * Google's confirmed/cancelled mapped onto two of its pages. */
	status: { mode: 'builtin', collectionGuid: null, label: '', confirmed: null, cancelled: null },
	/* Optional: your own Google Cloud OAuth client instead of the built-in one. */
	oauth: { clientId: '', clientSecret: '' },
	/* What to do with Attendees on events you create/edit in Thymer:
	 * 'off' = documentation only, never sent; 'silent' = put them on the Google
	 * event without e-mail; 'invite' = send real invitations. */
	attendeesPush: 'off',
	zoomLink: '',           // the user's personal Zoom room URL
	places: true,           // suggest places (OpenStreetMap) while typing a Location
	accounts: [],           // e-mails of connected Google accounts (shared across devices)
};

/* Field ids are fixed so the schema is recognisable across installs. 15 chars,
 * the shape Thymer generates itself. Labels are what the code reads by. */
const F = {
	gtitle:   { id: 'FGCALGTITLE0001', label: 'Google Title', type: 'text',     icon: 'ti-globe' },
	when:     { id: 'FGCALWHEN000001', label: 'When',         type: 'datetime', icon: 'ti-calendar-event' },
	due:      { id: 'FGCALDUEDATE001', label: 'Due Date',     type: 'datetime', icon: 'ti-calendar-event' },
	calendar: { id: 'FGCALCALEND0001', label: 'Calendar',     type: 'choice',   icon: 'ti-calendar' },
	attendees:{ id: 'FGCALATTEND0001', label: 'Attendees',    type: 'record',   icon: 'ti-users', many: true },
	organizer:{ id: 'FGCALORGANI0001', label: 'Organizer',    type: 'record',   icon: 'ti-user' },
	location: { id: 'FGCALLOCATI0001', label: 'Location',     type: 'text',     icon: 'ti-location' },
	response: { id: 'FGCALRESPON0001', label: 'My Response',  type: 'choice',   icon: 'ti-user-check' },
	status:   { id: 'FGCALSTATUS0001', label: 'Status',       type: 'choice',   icon: 'ti-circle-check' },
	link:     { id: 'FGCALLINK000001', label: 'Google Link',  type: 'url',      icon: 'ti-external-link' },
	eventId:  { id: 'FGCALEVENTI0001', label: 'Event ID',     type: 'text',     icon: 'ti-hash' },
	calId:    { id: 'FGCALCALID00001', label: 'Calendar ID',  type: 'text',     icon: 'ti-hash' },
	updated:  { id: 'FGCALUPDATE0001', label: 'Google Updated', type: 'text',   icon: 'ti-clock' },
	astatus:  { id: 'FGCALASTATU0001', label: 'Action Status', type: 'record',   icon: 'ti-circle-check' },
	invites:  { id: 'FGCALINVITE0001', label: 'Invitations',  type: 'choice',   icon: 'ti-mail' },
	meet:     { id: 'FGCALMEET000001', label: 'Meeting Link', type: 'url',      icon: 'ti-video' },
};
const INVITE_CHOICES = [
	{ id: 'CGCALITHYMER001', label: "Don't Send Invitations", color: 7 },
	{ id: 'CGCALIINVITE001', label: 'Send Invitations', color: 2 },
];
const INVITE_RETIRED = ['CGCALISILENT001'];
const INVITE_MODE_BY_CHOICE = { CGCALITHYMER001: 'off', CGCALISILENT001: 'off', CGCALIINVITE001: 'invite' };
const RESPONSE_CHOICES = [
	{ id: 'CGCALRACCEPT001', label: 'Accepted', color: 2 },
	{ id: 'CGCALRDECLIN001', label: 'Declined', color: 0 },
	{ id: 'CGCALRTENTAT001', label: 'Tentative', color: 4 },
	{ id: 'CGCALRNEEDSA001', label: 'Needs Action', color: 7 },
];
const RESPONSE_BY_GOOGLE = { accepted: 'CGCALRACCEPT001', declined: 'CGCALRDECLIN001', tentative: 'CGCALRTENTAT001', needsAction: 'CGCALRNEEDSA001' };
const STATUS_CHOICES = [
	{ id: 'CGCALSCONFIR001', label: 'Confirmed', color: 2 },
	{ id: 'CGCALSCANCEL001', label: 'Cancelled', color: 0 },
];
const STATUS_BY_GOOGLE = { confirmed: 'CGCALSCONFIR001', tentative: 'CGCALSCONFIR001', cancelled: 'CGCALSCANCEL001' };
const V_CALENDAR = 'VGCALCALEND0001';
const V_TABLE = 'VGCALTABLE00001';
const PSET_EVENT = 'PGCALEVENT00001';

const GC_CSS = `
.gc-backdrop { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.35); }
.gc-modal {
	--gc-fg: var(--color-text-100, #ededed);
	--gc-fg2: color-mix(in srgb, var(--color-text-100, #ededed) 62%, var(--cmdpal-bg-color, #212126));
	--gc-fg3: var(--color-text-700, #8a8a8a);
	--gc-line: color-mix(in srgb, var(--color-text-100, #ededed) 6%, transparent);
	--gc-edge: color-mix(in srgb, var(--color-text-100, #ededed) 10%, transparent);
	--gc-raise: color-mix(in srgb, var(--color-text-100, #ededed) 2.5%, transparent);
	--gc-hover: color-mix(in srgb, var(--color-text-100, #ededed) 7%, transparent);
	--gc-field: var(--input-bg-color, #111113);
	--gc-accent: var(--color-primary-500, #65c8bb);
	--gc-sel: var(--cmdpal-selected-bg-color, #44837b);
	--gc-sel-fg: var(--cmdpal-selected-fg-color, #ededed);
	--gc-warn: #e0b050;
	--gc-r: var(--radius-normal, 3px);
	position: fixed; z-index: 100001; top: 50%; left: 50%; transform: translate(-50%, -50%);
	width: 780px; height: 620px; max-width: calc(100vw - 24px); max-height: calc(100vh - 48px);
	display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
	background: var(--cmdpal-bg-color, #212126); color: var(--gc-fg);
	border: 1px solid var(--gc-edge); border-radius: var(--gc-r);
	box-shadow: 0 24px 64px rgba(0,0,0,.55);
	font-size: 13.5px;
}
.gc-modal * { box-sizing: border-box; }
.gc-modal .ti { font-size: 16px; line-height: 1; }
.gc-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 14px; border-bottom: 1px solid var(--gc-line); flex: none; }
.gc-head-icon { width: 32px; height: 32px; border-radius: var(--gc-r); flex: none; display: flex; align-items: center; justify-content: center; color: var(--gc-accent); background: color-mix(in srgb, var(--gc-accent) 12%, transparent); }
.gc-head-icon .ti { font-size: 18px; }
.gc-head-text { flex: 1; min-width: 0; }
.gc-head h3 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.gc-head p { margin: 3px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--gc-fg2); }
.gc-head p b { color: var(--gc-fg); font-weight: 600; }
.gc-iconbtn { width: 30px; height: 30px; flex: none; border: 0; padding: 0; border-radius: var(--gc-r); background: transparent; color: var(--gc-fg2); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.gc-iconbtn:hover { color: var(--gc-fg); background: var(--gc-hover); }
.gc-body { flex: 1; min-height: 0; display: flex; }
.gc-nav { width: 214px; flex: none; padding: 12px 10px; border-right: 1px solid var(--gc-line); display: flex; flex-direction: column; gap: 2px; }
.gc-nav-short { display: none; }
.gc-nav-sep { height: 1px; background: var(--gc-line); margin: 8px 6px; flex: none; }
.gc-nav button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 0; border-radius: var(--gc-r); background: transparent; color: var(--gc-fg2); font: inherit; font-size: 13px; text-align: left; cursor: pointer; white-space: nowrap; }
.gc-nav button:hover { color: var(--gc-fg); }
.gc-nav button.is-on { background: var(--gc-hover); color: var(--gc-fg); }
.gc-content { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 20px 24px 24px; }
.gc-pane { display: none; flex-direction: column; gap: 22px; }
.gc-pane.is-on { display: flex; }
.gc-pane h2 { margin: 0; font-size: 14px; font-weight: 600; }
.gc-pane-lead { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--gc-fg2); }
.gc-group { display: flex; flex-direction: column; gap: 8px; }
.gc-cap { display: flex; align-items: baseline; justify-content: space-between; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--gc-fg3); }
.gc-cap span { font-size: 12px; letter-spacing: 0; text-transform: none; color: var(--gc-fg2); }
.gc-box { border: 1px solid var(--gc-line); border-radius: var(--gc-r); background: var(--gc-raise); }
.gc-row { display: flex; align-items: center; gap: 12px 16px; padding: 12px 14px; flex-wrap: wrap; }
.gc-row + .gc-row { border-top: 1px solid var(--gc-line); }
.gc-row-text { flex: 1 1 200px; min-width: 0; }
.gc-row-title { font-size: 13.5px; color: var(--gc-fg); display: flex; align-items: center; gap: 10px; }
.gc-row-sub { font-size: 12px; line-height: 1.45; color: var(--gc-fg2); margin-top: 2px; }
.gc-row-sub.is-warn { color: var(--gc-warn); }
.gc-note { margin: 0; font-size: 12px; line-height: 1.55; color: var(--gc-fg3); }
.gc-tile { width: 28px; height: 28px; border-radius: var(--gc-r); flex: none; display: flex; align-items: center; justify-content: center; color: var(--gc-fg2); background: color-mix(in srgb, var(--gc-fg) 5%, transparent); }
.gc-avatar { width: 28px; height: 28px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: var(--gc-fg); }
.gc-inline { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--gc-fg2); }
.gc-input { padding: 6px 10px; border: 1px solid var(--gc-edge); border-radius: var(--gc-r); background: var(--gc-field); color: var(--gc-fg); font-family: inherit; font-size: 13px; outline: none; width: 100%; }
.gc-input:focus, .gc-pick:focus-visible { border-color: color-mix(in srgb, var(--gc-accent) 60%, transparent); }
.gc-input.gc-num { width: 52px; padding: 6px 8px; text-align: right; -moz-appearance: textfield; }
.gc-input.gc-num::-webkit-inner-spin-button, .gc-input.gc-num::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.gc-w { width: 220px; flex: none; }
.gc-pick { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--gc-edge); border-radius: var(--gc-r); background: var(--gc-field); color: var(--gc-fg); font: inherit; font-size: 13px; text-align: left; cursor: pointer; outline: none; }
.gc-pick .ti { color: var(--gc-fg2); font-size: 15px; }
.gc-pick-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: clip; white-space: nowrap; }
.gc-pick-label.is-empty { color: var(--gc-fg3); }
.gc-pick .gc-pick-chev { color: var(--gc-fg3); font-size: 14px; }
.gc-pick[disabled] { opacity: .5; cursor: default; }
.gc-field { display: flex; flex-direction: column; gap: 6px; }
.gc-field label, .gc-field-label { font-size: 12.5px; color: var(--gc-fg2); }
.gc-btn { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--gc-edge); border-radius: var(--gc-r); background: transparent; color: var(--gc-fg2); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.gc-btn:hover { color: var(--gc-fg); filter: brightness(1.15); }
.gc-btn .ti { font-size: 14px; }
.gc-btn.gc-soft { background: color-mix(in srgb, var(--gc-fg) 3%, transparent); color: var(--gc-fg); }
.gc-btn.gc-primary { background: var(--gc-sel); border-color: var(--gc-sel); color: var(--gc-sel-fg); font-weight: 600; }
.gc-btn.gc-ghost { border-color: transparent; }
.gc-btn[disabled] { opacity: .5; cursor: default; filter: none; }
.gc-ready { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--gc-accent); }
.gc-ready .ti { font-size: 13px; }
.gc-cal { display: flex; align-items: center; gap: 12px; padding: 7px 14px; cursor: pointer; }
.gc-cal:hover .gc-cal-name { color: var(--gc-fg); }
.gc-cal-acct { padding: 10px 14px 4px; font-size: 12px; color: var(--gc-fg3); }
.gc-cals { padding: 4px 0; }
.gc-cals > .gc-note { padding: 10px 14px; }
.gc-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.gc-cal-name { flex: 1; min-width: 0; font-size: 13.5px; color: var(--gc-fg2); }
.gc-cal:has(input:checked) .gc-cal-name { color: var(--gc-fg); }
.gc-tag { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--gc-fg3); border: 1px solid var(--gc-edge); border-radius: var(--gc-r); padding: 2px 6px; white-space: nowrap; }
.gc-check { appearance: none; -webkit-appearance: none; width: 18px; height: 18px; margin: 0; flex: none; border-radius: var(--gc-r); border: 1px solid color-mix(in srgb, var(--gc-fg) 28%, transparent); background: transparent; cursor: pointer; }
.gc-check:checked { border-color: var(--gc-sel); background: var(--gc-sel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ededed' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12l5 5l10 -10'/%3E%3C/svg%3E") center / 12px no-repeat; }
.gc-switch { position: relative; width: 36px; height: 20px; flex: none; cursor: pointer; }
.gc-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.gc-switch span { position: absolute; inset: 0; border-radius: 10px; background: color-mix(in srgb, var(--gc-fg) 16%, transparent); transition: background .15s; pointer-events: none; }
.gc-switch span::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--gc-fg); transition: transform .15s; }
.gc-switch input:checked + span { background: var(--gc-sel); }
.gc-switch input:checked + span::after { transform: translateX(16px); }
.gc-switch input:focus-visible + span { outline: 2px solid color-mix(in srgb, var(--gc-accent) 60%, transparent); outline-offset: 2px; }
.gc-seg { display: flex; padding: 2px; border: 1px solid var(--gc-edge); border-radius: var(--gc-r); background: var(--gc-field); }
.gc-seg button { padding: 5px 12px; border: 0; border-radius: 2px; background: transparent; color: var(--gc-fg2); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.gc-seg button:hover { color: var(--gc-fg); }
.gc-seg button.is-on { background: var(--gc-sel); color: var(--gc-sel-fg); }
.gc-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.gc-card { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--gc-edge); border-radius: var(--gc-r); background: var(--gc-raise); cursor: pointer; }
.gc-card input { position: absolute; opacity: 0; pointer-events: none; }
.gc-card-dot { width: 14px; height: 14px; flex: none; margin-top: 2px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--gc-fg) 30%, transparent); }
.gc-card:has(input:checked) { border-color: color-mix(in srgb, var(--gc-accent) 55%, transparent); background: color-mix(in srgb, var(--gc-accent) 6%, transparent); }
.gc-card:has(input:checked) .gc-card-dot { border: 4px solid var(--gc-accent); }
.gc-card:has(input:focus-visible) { outline: 2px solid color-mix(in srgb, var(--gc-accent) 60%, transparent); outline-offset: 2px; }
.gc-card-text { display: flex; flex-direction: column; gap: 3px; }
.gc-card-title { font-size: 13.5px; color: var(--gc-fg); }
.gc-card-sub { font-size: 12px; line-height: 1.45; color: var(--gc-fg2); }
.gc-map { display: flex; align-items: center; gap: 10px; flex: 1 1 180px; font-size: 13.5px; }
.gc-map .ti { color: var(--gc-fg3); font-size: 14px; }
.gc-uri { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 10px; border: 1px dashed color-mix(in srgb, var(--gc-fg) 12%, transparent); border-radius: var(--gc-r); }
.gc-uri code { flex: 1; min-width: 0; font-family: inherit; font-size: 12px; color: var(--gc-fg2); overflow-wrap: anywhere; }
.gc-warnline { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5; color: var(--gc-warn); }
.gc-warnline .ti { font-size: 15px; margin-top: 1px; }
.gc-adv { padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.gc-subfield { padding: 0 14px 14px 54px; display: flex; flex-direction: column; gap: 6px; }
.gc-foot { display: flex; align-items: center; gap: 12px; padding: 12px 16px 12px 20px; border-top: 1px solid var(--gc-line); flex: none; }
/* first run: "Before the first sync" (his design 2026-10-18) */
.gc-setup .gc-content { display: flex; flex-direction: column; gap: 26px; }
.gc-step { display: flex; flex-direction: column; gap: 10px; }
.gc-step-head { display: flex; align-items: center; gap: 10px; }
.gc-step-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.gc-step-head p { margin: 2px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--gc-fg2); }
.gc-step-text { flex: 1; min-width: 0; }
.gc-step-count { font-size: 12px; color: var(--gc-fg2); white-space: nowrap; }
.gc-badge { width: 22px; height: 22px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; border: 1px solid color-mix(in srgb, var(--gc-fg) 25%, transparent); color: var(--gc-fg2); }
.gc-badge.is-done { border-color: var(--gc-sel); background: var(--gc-sel); color: var(--gc-sel-fg); }
.gc-cards.gc-cards3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.gc-setup-note { flex: 1; min-width: 0; font-size: 12px; color: var(--gc-fg2); }
.gc-setup-note.is-ready { color: var(--gc-accent); }
.gc-status { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--gc-fg2); }
.gc-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--gc-accent); flex: none; }
.gc-status:empty::before { display: none; }
.gc-foot-btns { display: flex; gap: 8px; flex: none; }
.gc-foot .gc-btn { padding: 7px 12px; font-size: 13px; }
.gc-foot .gc-btn.gc-primary { padding: 7px 16px; }
.gc-menu { position: fixed; z-index: 100003; display: flex; flex-direction: column; max-height: 300px; padding: 4px; border: 1px solid color-mix(in srgb, var(--color-text-100, #ededed) 10%, transparent); border-radius: var(--radius-normal, 3px); background: var(--cmdpal-bg-color, #212126); color: var(--color-text-100, #ededed); box-shadow: 0 12px 32px rgba(0,0,0,.5); font-size: 13px; }
.gc-menu-search { margin: 2px 2px 4px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--color-text-100, #ededed) 10%, transparent); border-radius: var(--radius-normal, 3px); background: var(--input-bg-color, #111113); color: inherit; font: inherit; font-size: 13px; outline: none; }
.gc-menu-list { overflow-y: auto; min-height: 0; }
.gc-menu-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-normal, 3px); cursor: pointer; white-space: nowrap; }
.gc-menu-item .ti { font-size: 15px; opacity: .75; }
.gc-menu-item .gc-menu-check { margin-left: auto; opacity: 1; }
.gc-menu-item.is-active { background: var(--cmdpal-selected-bg-color, #44837b); color: var(--cmdpal-selected-fg-color, #ededed); }
.gc-menu-empty { padding: 8px; color: var(--color-text-700, #8a8a8a); }
.gc-places .gc-menu-item { align-items: flex-start; white-space: normal; }
.gc-places .gc-menu-item .ti { margin-top: 2px; }
.gc-place-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.gc-place-sub { font-size: 12px; opacity: .65; }
.gc-places-foot { padding: 6px 8px 4px; font-size: 11px; color: var(--color-text-700, #8a8a8a); border-top: 1px solid color-mix(in srgb, var(--color-text-100, #ededed) 6%, transparent); margin-top: 4px; }
@media (max-width: 640px) {
	.gc-modal { top: 0; left: 0; transform: none; width: 100vw; height: 100%; max-width: none; max-height: none; border: 0; border-radius: 0; box-shadow: none; }
	.gc-body { flex-direction: column; }
	.gc-nav { width: auto; flex-direction: row; gap: 6px; padding: 10px 16px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--gc-line); }
	.gc-nav-sep, .gc-nav button .ti, .gc-nav-long { display: none; }
	.gc-nav-short { display: inline; }
	.gc-nav button { width: auto; flex: none; padding: 8px 14px; font-size: 14px; border: 1px solid var(--gc-edge); }
	.gc-nav button.is-on { border-color: var(--gc-sel); background: color-mix(in srgb, var(--gc-accent) 12%, transparent); }
	.gc-content { padding: 18px 16px 24px; }
	.gc-cards, .gc-cards.gc-cards3 { grid-template-columns: minmax(0, 1fr); }
	.gc-w { width: 100%; }
	.gc-input, .gc-pick, .gc-menu-search { font-size: 16px; }
	.gc-foot { flex-direction: column; align-items: stretch; padding: 12px 16px 28px; }
	.gc-foot-btns { justify-content: flex-end; }
}
`;

class Plugin extends AppPlugin {
	cfgCache = null;
	commands = [];
	modalEl = null;
	modalBackdrop = null;
	timer = null;
	syncing = false;
	offProto = null;
	msgHandler = null;
	eventIds = [];
	calendarLists = {};    // account -> last fetched calendarList (for the dialog)
	lastSyncSummary = '';
	lastSyncAt = 0;
	placeMenu = null;
	placesTimer = null;
	placesSeq = 0;
	placesBusy = false;
	placesShownSeq = 0;
	placesOff = null;
	placesCommitting = false;
	placesCache = new Map();
	settingsSection = 'accounts';
	menuEl = null;
	menuOff = null;
	destroyed = false;
	outbound = new Map();     // record guid -> debounce timer
	meetRequests = new Set(); // records whose next push should attach a Google Meet
	localWrites = new Map();  // record guid -> time of our own last write (echo guard)
	warnedReadOnly = {};

	// ── lifecycle ────────────────────────────────────────────────────────────

	onLoad() {
		this.instanceId = Math.random().toString(36).slice(2, 8);
		if (GC_DEV) window.__gcalInstances = (window.__gcalInstances || []).concat([{ id: this.instanceId, loaded: Date.now(), destroyed: false }]);
		this.log('onLoad');
		this.claimLegacyStorage();
		if (GC_DEV) { window.__gcalDT = DateTime; window.__gcalPlugin = this; }
		this.ui.injectCSS(GC_CSS);
		this.commands.push(this.ui.addCommandPaletteCommand({
			label: 'Google Calendar: Settings',
			icon: 'ti-calendar-event',
			onSelected: () => this.openSettings(),
		}));
		this.commands.push(this.ui.addCommandPaletteCommand({
			label: 'Google Calendar: Sync Now',
			icon: 'ti-refresh',
			onSelected: () => this.syncNow(true),
		}));
		this.commands.push(this.ui.addCommandPaletteCommand({
			label: 'Google Calendar: Add Google Meet Link',
			icon: 'ti-video',
			onSelected: () => this.addMeetingLink('meet'),
		}));
		this.commands.push(this.ui.addCommandPaletteCommand({
			label: 'Google Calendar: Add Zoom Link',
			icon: 'ti-video',
			onSelected: () => this.addMeetingLink('zoom'),
		}));

		/* The OAuth return path. Desktop: Thymer forwards thymer:// deep links
		 * here. Web: the callback page posts to the opener window. */
		try {
			const api = window.thymerDesktopAPI;
			if (api && typeof api.onProtocolAction === 'function') {
				this.offProto = api.onProtocolAction((p) => this.onProtocolAction(p));
			}
		} catch (e) { /* not the desktop app */ }
		this.msgHandler = (ev) => {
			const d = ev && ev.data;
			if (d && d.type === 'thymer-gcal-oauth') this.onAuthReturn(d.code, d.state, d.error);
		};
		window.addEventListener('message', this.msgHandler);

		this.watchCollection();
		this.hookPlaces();
		/* a release queued before a reload is saved now */
		if (this.releaseQueue().add.length || this.releaseQueue().remove.length) setTimeout(() => { this.flushReleased().catch(() => {}); }, 4000);
		let reopen = false;
		try { reopen = window.localStorage.getItem(this.k(LS_REOPEN)) === '1'; window.localStorage.removeItem(this.k(LS_REOPEN)); } catch (e) {}
		if (reopen) setTimeout(() => this.openSettings(), 300);
		this.schedule(reopen ? 60000 : 8000);
	}

	onUnload() {
		/* A reload must not leave a ghost: every loop checks this flag. */
		this.destroyed = true;
		this.log('onUnload');
		for (const i of (window.__gcalInstances || [])) if (i.id === this.instanceId) i.destroyed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		for (const t of this.outbound.values()) clearTimeout(t);
		this.outbound.clear();
		if (this.offProto) { try { this.offProto(); } catch (e) {} }
		this.offProto = null;
		if (this.msgHandler) window.removeEventListener('message', this.msgHandler);
		this.msgHandler = null;
		for (const id of this.eventIds) { try { this.events.off(id); } catch (e) {} }
		this.eventIds = [];
		this.closeSettings();
		if (this.placesOff) { try { this.placesOff(); } catch (e) {} this.placesOff = null; }
		for (const c of this.commands) { try { c.destroy ? c.destroy() : c.remove(); } catch (e) {} }
		this.commands = [];
	}

	// ── settings persistence ──────────────────────────────────────────────────

	/* Per-workspace localStorage key. Every workspace of an account shares one
	 * origin, so unsuffixed keys let a second workspace read and overwrite the
	 * first one's tokens, sync state and settings mirror. */
	k(name) { return name + ':' + this.getWorkspaceGuid(); }

	/* Keys written before they were per workspace belong to exactly one of them:
	 * the one whose synced configuration names the same events collection as the
	 * legacy settings mirror. Any other workspace starts clean and leaves them. */
	claimLegacyStorage() {
		try {
			const ls = window.localStorage;
			const legacy = JSON.parse(ls.getItem(LS_SETTINGS) || 'null');
			if (!legacy) return;
			if (ls.getItem(this.k(LS_SETTINGS))) return;
			const conf = this.getConfiguration();
			const mine = conf && conf.custom && conf.custom.gcal && conf.custom.gcal.collectionGuid;
			if (!mine || mine !== legacy.collectionGuid) return;
			for (const name of [LS_SETTINGS, LS_TOKENS, LS_STATE, LS_PENDING, LS_REOPEN]) {
				const v = ls.getItem(name);
				if (v != null) ls.setItem(this.k(name), v);
				ls.removeItem(name);
			}
			this.log('claimed legacy storage for ' + this.getWorkspaceGuid());
		} catch (e) { /* stay on the defaults; nothing was removed before its copy landed */ }
	}

	cfg() {
		if (this.cfgCache) {
			/* Another writer (a dialog, a cleanup, a newer instance) may have moved
			 * the mirror on; a newer rev invalidates the cache. */
			let mrev = 0;
			try { mrev = (JSON.parse(window.localStorage.getItem(this.k(LS_SETTINGS)) || 'null') || {}).rev || 0; } catch (e) {}
			if (mrev <= (this.cfgCache.rev || 0)) return this.cfgCache;
			this.cfgCache = null;
		}
		let stored = null, storedRev = 0, mirror = null, mirrorRev = 0;
		try {
			const conf = this.getConfiguration();
			if (conf && conf.custom && conf.custom.gcal) { stored = conf.custom.gcal; storedRev = stored.rev || 0; }
		} catch (e) {}
		try {
			const raw = JSON.parse(window.localStorage.getItem(this.k(LS_SETTINGS)) || 'null');
			if (raw && typeof raw === 'object') { mirror = raw; mirrorRev = raw.rev || 0; }
		} catch (e) {}
		const chosen = (stored && storedRev >= mirrorRev) ? stored : (mirror || stored) || {};
		const out = Object.assign({}, GC_DEFAULTS, chosen);
		out.persons = Object.assign({}, GC_DEFAULTS.persons, chosen.persons || {});
		out.status = Object.assign({}, GC_DEFAULTS.status, chosen.status || {});
		out.oauth = Object.assign({}, GC_DEFAULTS.oauth, chosen.oauth || {});
		out.accounts = Array.isArray(chosen.accounts) ? chosen.accounts.slice() : [];
		/* Legacy single-account shape: { account: {email}, calendars: {calId: …} }. */
		const legacyEmail = chosen.account && chosen.account.email;
		if (legacyEmail && !out.accounts.includes(legacyEmail)) out.accounts.push(legacyEmail);
		out.calendars = {};
		for (const [k, c] of Object.entries(chosen.calendars || {})) {
			if (k.includes('|')) { out.calendars[k] = Object.assign({}, c); continue; }
			const acct = legacyEmail || out.accounts[0] || '';
			if (!acct) continue;
			out.calendars[this.calKey(acct, k)] = Object.assign({}, c, { account: acct, calId: k });
		}
		out.rev = Math.max(storedRev, mirrorRev);
		this.cfgCache = out;
		return out;
	}

	/* Settings that must not trigger a plugin reload yet (mid-sign-in): the
	 * mirror wins on the next cfg() read because its rev is newer, and the
	 * synced copy catches up on the next saveCfg. */
	stageCfg(patch) {
		const value = Object.assign({}, this.cfg(), patch || {}, { rev: Date.now() });
		this.cfgCache = value;
		try { window.localStorage.setItem(this.k(LS_SETTINGS), JSON.stringify(value)); } catch (e) {}
		return value;
	}

	async saveCfg(patch) {
		const value = this.stageCfg(patch);
		try {
			const conf = this.getConfiguration() || {};
			conf.custom = conf.custom || {};
			conf.custom.gcal = value;
			let all = this.data.getAllGlobalPlugins();
			if (all && typeof all.then === 'function') all = await all;
			const mine = (all || []).find((g) => g.guid === this.getGuid() || (g.getGuid && g.getGuid() === this.getGuid()));
			if (mine && typeof mine.saveConfiguration === 'function') mine.saveConfiguration(conf);
		} catch (e) { /* localStorage still holds it */ }
	}

	/* Tokens are per device and never go into the synced configuration. */
	tokens() {
		let t = null;
		try { t = JSON.parse(window.localStorage.getItem(this.k(LS_TOKENS)) || 'null'); } catch (e) {}
		if (!t) return {};
		if (t.refresh_token) {
			/* Legacy single-account shape: file it under the account we knew. */
			const email = this.cfg().accounts[0] || 'default';
			const map = {}; map[email] = t;
			this.setTokens(map);
			return map;
		}
		return t;
	}
	setTokens(map) {
		try {
			if (map && Object.keys(map).length) window.localStorage.setItem(this.k(LS_TOKENS), JSON.stringify(map));
			else window.localStorage.removeItem(this.k(LS_TOKENS));
		} catch (e) {}
	}
	tokensFor(email) { const t = this.tokens()[email]; return t && t.refresh_token ? t : null; }
	setTokensFor(email, t) { const map = this.tokens(); if (t) map[email] = t; else delete map[email]; this.setTokens(map); }
	/* Accounts signed in on THIS device. */
	signedIn() { return Object.entries(this.tokens()).filter(([, t]) => t && t.refresh_token).map(([e]) => e); }
	connected() { return this.signedIn().length > 0; }
	calKey(email, calId) { return email + '|' + calId; }
	parseCalKey(key) {
		if (!key) return null;
		const i = key.indexOf('|');
		if (i < 0) { const acct = this.cfg().accounts[0] || ''; return acct ? { account: acct, calId: key, key: this.calKey(acct, key) } : null; }
		return { account: key.slice(0, i), calId: key.slice(i + 1), key };
	}

	/* Sync bookkeeping: which Google event became which page, and which pages
	 * the user trashed (those must not come back). Per device. */
	state() {
		try {
			const s = JSON.parse(window.localStorage.getItem(this.k(LS_STATE)) || 'null') || {};
			s.records = s.records || {};
			s.ignored = s.ignored || {};
			s.ignoredPeople = s.ignoredPeople || {};
			s.born = s.born || {};              // sync-created pages: guid -> {t, lines}
			s.pendingCancels = s.pendingCancels || {};   // key -> first-seen ts
			return s;
		} catch (e) { return { records: {}, ignored: {}, ignoredPeople: {}, born: {}, pendingCancels: {} }; }
	}
	setState(s) { try { window.localStorage.setItem(this.k(LS_STATE), JSON.stringify(s)); } catch (e) {} }

	// ── OAuth ─────────────────────────────────────────────────────────────────

	/* The single point of contact with the OAuth client credentials. */
	clientId() { const o = this.cfg().oauth || {}; return (o.clientId || '').trim() || GC_CLIENT_ID; }
	ownClient() { const o = this.cfg().oauth || {}; return !!(o.clientId || '').trim(); }
	clientSecret() { return this.ownClient() ? ((this.cfg().oauth || {}).clientSecret || '').trim() : ''; }

	async startAuth() {
		const verifier = this.randomString(64);
		const challenge = this.base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
		const nonce = this.randomString(16);
		const isDesktop = !!(window.thymerDesktopAPI && window.thymerDesktopAPI.onProtocolAction);
		const state = this.base64url(new TextEncoder().encode(JSON.stringify({
			n: nonce, h: window.location.host, w: 'gcal', d: isDesktop ? 1 : 0,
		})));
		try { window.localStorage.setItem(this.k(LS_PENDING), JSON.stringify({ verifier, nonce, started: Date.now() })); } catch (e) {}
		const q = new URLSearchParams({
			client_id: this.clientId(),
			redirect_uri: GC_REDIRECT_URI,
			response_type: 'code',
			scope: GC_SCOPE,
			access_type: 'offline',
			prompt: 'consent',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state,
		});
		const url = GC_AUTH_URL + '?' + q.toString();
		if (isDesktop) {
			window.open(url, '_blank');          // Electron hands this to the system browser
		} else {
			window.open(url, 'thymer-gcal-oauth', 'width=520,height=700');
		}
	}

	onProtocolAction(p) {
		if (!p || p.action !== GC_ACTION) return;
		/* main.js delivers the action but does not raise the window; do it here. */
		try { const api = window.thymerDesktopAPI; if (api) { if (api.windowShow) api.windowShow(); if (api.windowFocus) api.windowFocus(); } } catch (e) {}
		this.onAuthReturn(p.code, p.state, p.error);
	}

	async onAuthReturn(code, state, error) {
		let pending = null;
		try { pending = JSON.parse(window.localStorage.getItem(this.k(LS_PENDING)) || 'null'); } catch (e) {}
		if (!pending || Date.now() - (pending.started || 0) > 15 * 60000) return;
		let parsed = null;
		try { parsed = JSON.parse(new TextDecoder().decode(this.fromBase64url(state || ''))); } catch (e) {}
		if (!parsed || parsed.n !== pending.nonce) return;   // not ours
		try { window.localStorage.removeItem(this.k(LS_PENDING)); } catch (e) {}
		if (error || !code) { this.setStatus('Google sign-in failed: ' + (error || 'no code')); return; }
		this.setStatus('Finishing sign-in');
		try {
			const tok = await this.tokenRequest({
				grant_type: 'authorization_code',
				code,
				code_verifier: pending.verifier,
				redirect_uri: GC_REDIRECT_URI,
			});
			if (!tok.refresh_token) throw new Error('Google returned no refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
			const fresh = {
				access_token: tok.access_token,
				refresh_token: tok.refresh_token,
				expires_at: Date.now() + (tok.expires_in || 3600) * 1000 - 60000,
			};
			/* We do not know which account this is until we ask Google. */
			this.setTokensFor('__pending', fresh);
			let email = '';
			try {
				const list = await this.fetchCalendarList('__pending');
				const primary = list.find((c) => c.primary);
				email = (primary && primary.id) || '';
			} finally { this.setTokensFor('__pending', null); }
			if (!email) throw new Error('Could not determine the Google account e-mail');
			this.setTokensFor(email, fresh);
			this.calendarLists[email] = this.calendarLists.__pending; delete this.calendarLists.__pending;
			const accounts = this.cfg().accounts.slice();
			if (!accounts.includes(email)) accounts.push(email);
			this.toast('Connected Google account ' + email);
			/* saveCfg reloads the plugin; the next instance reopens the dialog. */
			try { window.localStorage.setItem(this.k(LS_REOPEN), '1'); } catch (e) {}
			await this.saveCfg({ accounts });
		} catch (e) {
			this.setStatus('Sign-in failed: ' + (e.message || e));
		}
	}

	async tokenRequest(params) {
		const own = this.ownClient();
		const body = new URLSearchParams(Object.assign({ client_id: this.clientId() }, own ? { client_secret: this.clientSecret() } : {}, params));
		const res = await fetch(own ? GC_TOKEN_URL : GC_TOKEN_RELAY, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});
		const json = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(json.error_description || json.error || ('token endpoint ' + res.status));
		return json;
	}

	async accessToken(account) {
		const t = this.tokensFor(account);
		if (!t) throw new Error('Not signed in to ' + account + ' on this device');
		if (t.access_token && t.expires_at > Date.now()) return t.access_token;
		let tok;
		try {
			tok = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
		} catch (e) {
			if (/expired or revoked|invalid_grant/i.test(String(e.message || e))) {
				/* Google killed the refresh token (access removed in the Google
				 * account, or expired). Half-dead tokens only cause a
				 * failing toast per sync; better to sign out and say so once. */
				this.setTokensFor(account, null);
				this.toast('Google signed ' + account + ' out (access was removed or expired). Open Google Calendar: Settings and sign in again.');
			}
			throw e;
		}
		const next = {
			access_token: tok.access_token,
			refresh_token: tok.refresh_token || t.refresh_token,
			expires_at: Date.now() + (tok.expires_in || 3600) * 1000 - 60000,
		};
		this.setTokensFor(account, next);
		return next.access_token;
	}

	/* Removes the account everywhere: tokens on this device, its calendars and
	 * its entry in the shared settings. Pages already synced are left alone. */
	async disconnect(account) {
		const t = this.tokensFor(account);
		if (t) { try { await fetch(GC_REVOKE_URL + '?token=' + encodeURIComponent(t.refresh_token), { method: 'POST' }); } catch (e) {} }
		this.setTokensFor(account, null);
		delete this.calendarLists[account];
		const cfg = this.cfg();
		const calendars = {};
		for (const [k, c] of Object.entries(cfg.calendars)) if (c.account !== account) calendars[k] = c;
		await this.saveCfg({ accounts: cfg.accounts.filter((a) => a !== account), calendars });
	}

	/* One place for every Google API call: auth header, refresh-and-retry on
	 * 401, JSON errors surfaced as Error(message). */
	async gapi(account, path, opts) {
		opts = opts || {};
		let url = GC_API + path;
		if (opts.query) {
			const q = new URLSearchParams();
			for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null) q.set(k, String(v));
			url += (url.includes('?') ? '&' : '?') + q.toString();
		}
		const attempt = async (retry) => {
			const token = await this.accessToken(account);
			const res = await fetch(url, {
				method: opts.method || 'GET',
				headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.body ? { 'Content-Type': 'application/json' } : {}),
				body: opts.body ? JSON.stringify(opts.body) : undefined,
			});
			if (res.status === 401 && retry) {
				const t = this.tokensFor(account); if (t) { t.expires_at = 0; this.setTokensFor(account, t); }
				return attempt(false);
			}
			if (res.status === 204) return null;
			const json = await res.json().catch(() => ({}));
			if (!res.ok) {
				const msg = (json.error && (json.error.message || json.error)) || ('HTTP ' + res.status);
				const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
				err.status = res.status;
				throw err;
			}
			return json;
		};
		return attempt(true);
	}

	async fetchCalendarList(account) {
		const out = [];
		let pageToken = null;
		do {
			const page = await this.gapi(account, '/users/me/calendarList', { query: { maxResults: 250, showHidden: true, pageToken } });
			for (const c of page.items || []) out.push(c);
			pageToken = page.nextPageToken || null;
		} while (pageToken);
		this.calendarLists[account] = out;
		return out;
	}

	// ── the collection ────────────────────────────────────────────────────────

	async getCollection() {
		const cfg = this.cfg();
		const cols = await this.data.getAllCollections();
		if (cfg.collectionGuid) {
			const c = cols.find((x) => x.getGuid() === cfg.collectionGuid);
			if (c) return c;
		}
		return null;
	}

	/* Creates the events collection when missing, and keeps its schema in line
	 * (new calendars become choices, the people collection becomes the filter
	 * on Attendees/Organizer). Additive only: nothing the user added is touched. */
	async ensureCollection() {
		const cfg = this.cfg();
		let col = await this.getCollection();
		let created = false;
		if (!col && cfg.collectionGuid) {
			/* Configured but not found: the collection list may still be loading
			 * after a reload, or the user trashed it. Never silently create a
			 * second one; the user can reset the collection in Settings. */
			throw new Error('The events collection is not available yet (reload in progress, or it was trashed)');
		}
		if (!col) {
			/* Adopt an existing collection of that name before ever creating one. */
			const all = await this.data.getAllCollections();
			col = all.find((c) => c.getName() === (cfg.collectionName || 'Calendar') && !c.isJournalPlugin()) || null;
			if (col) {
				this.log('adopted existing collection ' + col.getGuid());
			} else {
				if (!all.length) throw new Error('No collections loaded yet');
				this.log('CREATING collection; cfg=' + JSON.stringify({ guid: cfg.collectionGuid, rev: cfg.rev }) + ' stack=' + new Error().stack);
				col = await this.data.createCollection();
				if (!col) throw new Error('Thymer refused to create a collection');
				created = true;
			}
		}
		const conf = col.getConfiguration();
		const before = JSON.stringify(conf);
		if (created) {
			conf.name = cfg.collectionName || 'Calendar';
			conf.item_name = 'Event';
			conf.icon = 'ti-calendar-event';
			conf.description = 'Events synced from Google Calendar.';
			conf.show_sidebar_items = false;
			conf.show_cmdpal_items = true;
		}
		conf.fields = conf.fields || [];
		conf.views = conf.views || [];

		/* The date lives in ONE property, When or Due Date. The other one is
		 * archived (never deleted), and when the choice changes every view,
		 * the property set and the sidebar sort follow it, and the pages' dates
		 * are copied across after the save (migrateDates). */
		const DF = this.dateF();
		const OTHER = DF === F.due ? F.when : F.due;
		const prevDate = [F.when, F.due].find((f) => { const x = conf.fields.find((y) => y.id === f.id); return x && x.active !== false; }) || null;
		const moved = !!prevDate && prevDate.id !== DF.id;
		/* The copy is resumable: a reload in the middle of it (a settings save
		 * reloads the plugin) left every page without a date and the next sync
		 * saw nothing left to move (measured 2026-10-18). The collection keeps a
		 * marker until the copy has finished. */
		conf.custom = conf.custom || {};
		if (moved) conf.custom.gcalDates = { from: prevDate.id, to: DF.id };
		const pending = conf.custom.gcalDates && conf.custom.gcalDates.to === DF.id ? conf.custom.gcalDates : null;
		/* released keys moved out of the collection's config (once): merged into
		 * our own config first, then removed here in the same single save */
		const oldReleased = Array.isArray(conf.custom.gcalReleased) ? conf.custom.gcalReleased : null;
		if (oldReleased) delete conf.custom.gcalReleased;
		const calChoices = this.calendarChoices(cfg);
		const personsGuid = cfg.persons.collectionGuid || undefined;
		const want = [
			this.fieldDef(F.gtitle), this.fieldDef(DF),
			Object.assign(this.fieldDef(F.calendar), { choices: calChoices }),
			Object.assign(this.fieldDef(F.attendees), { filter_colguid: personsGuid }),
			Object.assign(this.fieldDef(F.organizer), { filter_colguid: personsGuid }),
			this.fieldDef(F.location),
			Object.assign(this.fieldDef(F.response), { choices: RESPONSE_CHOICES.map((c) => this.choiceDef(c)) }),
			Object.assign(this.fieldDef(F.status), { choices: STATUS_CHOICES.map((c) => this.choiceDef(c)) }),
			Object.assign(this.fieldDef(F.invites), { choices: INVITE_CHOICES.map((c) => this.choiceDef(c)) }),
			this.fieldDef(F.meet),
			this.fieldDef(F.link), this.fieldDef(F.eventId), this.fieldDef(F.calId), this.fieldDef(F.updated),
		];
		/* The sync bookkeeping lives in ARCHIVED fields: gone from every
		 * property set (All, Filled-in, the user's own), while the plugin still
		 * reads and writes them by label (verified 2026-09-29: values persist and
		 * survive a reload). A property set could not hide them without also
		 * hiding every property the user adds later. */
		const hidden = [F.eventId.id, F.calId.id, F.updated.id];
		for (const w of want) {
			if (hidden.includes(w.id)) w.active = false;
			const existing = conf.fields.find((f) => f.id === w.id);
			if (!existing) { conf.fields.push(w); continue; }
			existing.active = !hidden.includes(w.id);
			if (w.icon && existing.icon !== w.icon) existing.icon = w.icon;
			if (w.id === F.invites.id && Array.isArray(w.choices)) {
				existing.choices = existing.choices || [];
				for (const c of w.choices) {
					const have = existing.choices.find((x) => x.id === c.id);
					if (have) { have.label = c.label; have.active = true; } else existing.choices.push(c);
				}
				for (const rid of INVITE_RETIRED) { const have = existing.choices.find((x) => x.id === rid); if (have) have.active = false; }
			}
			if (w.id === F.calendar.id) {
				/* merge choices: keep ids the user already has, add new calendars, rename to match Google */
				existing.choices = existing.choices || [];
				for (const c of calChoices) {
					const have = existing.choices.find((x) => x.id === c.id);
					if (have) { have.label = c.label; have.active = true; } else existing.choices.push(c);
				}
			}
			if (w.filter_colguid !== undefined && existing.filter_colguid !== w.filter_colguid) existing.filter_colguid = w.filter_colguid;
		}
		{ const o = conf.fields.find((f) => f.id === OTHER.id); if (o) o.active = false; }
		if (moved) {
			const swap = (id) => (id === prevDate.id ? DF.id : id);
			for (const v of conf.views) {
				if (Array.isArray(v.field_ids)) v.field_ids = v.field_ids.map(swap);
				if (v.sort_field_id) v.sort_field_id = swap(v.sort_field_id);
				if (v.opts && v.opts.date_field_id) v.opts.date_field_id = swap(v.opts.date_field_id);
			}
			for (const ps of conf.property_sets || []) if (ps && Array.isArray(ps.member_ids)) ps.member_ids = ps.member_ids.map(swap);
			if (conf.sidebar_record_sort_field_id) conf.sidebar_record_sort_field_id = swap(conf.sidebar_record_sort_field_id);
		}
		/* Status: exactly one of the two status fields is active. */
		const st = cfg.status || {};
		const useRecordStatus = st.mode === 'record' && !!st.collectionGuid;
		const builtin = conf.fields.find((f) => f.id === F.status.id);
		let astatus = conf.fields.find((f) => f.id === F.astatus.id);
		if (useRecordStatus) {
			const label = (st.label || '').trim() || F.astatus.label;
			if (!astatus) { astatus = Object.assign(this.fieldDef(F.astatus), { label, filter_colguid: st.collectionGuid }); conf.fields.push(astatus); }
			astatus.active = true; astatus.label = label; astatus.filter_colguid = st.collectionGuid; astatus.many = false;
			if (builtin) builtin.active = false;
		} else {
			if (builtin) builtin.active = true;
			if (astatus) astatus.active = false;
		}
		const statusFieldId = useRecordStatus ? F.astatus.id : F.status.id;
		const visible = ['title', DF.id, F.calendar.id, F.attendees.id, F.location.id, F.response.id, statusFieldId];
		/* Views are seeded ONCE, when the collection is created. Re-adding a
		 * missing view here resurrected the Calendar view every sync after the
		 * user deleted the tab (Parham, 2026-08-25) — a deleted view stays deleted. */
		if (created) {
			conf.views.unshift({
				id: V_CALENDAR, label: 'Calendar', description: '', type: 'calendar', icon: 'ti-calendar',
				shown: true, read_only: false, sort_field_id: DF.id, sort_dir: 'asc', group_by_field_id: null,
				field_ids: visible, opts: { date_field_id: DF.id },
			});
			conf.views.push({
				id: V_TABLE, label: 'Events', description: '', type: 'table', icon: 'ti-table',
				shown: true, read_only: false, sort_field_id: DF.id, sort_dir: 'desc', group_by_field_id: null,
				field_ids: visible.concat([F.gtitle.id, F.organizer.id, F.link.id]), opts: {},
			});
		}
		/* A property set that hides the sync bookkeeping from the page; "All"
		 * still shows everything. Only made the default while the user has not
		 * picked a set of their own. */
		conf.property_sets = Array.isArray(conf.property_sets) ? conf.property_sets : [];
		const pageFields = [F.gtitle.id, DF.id, F.calendar.id, F.attendees.id, F.organizer.id, F.location.id, F.response.id, statusFieldId, F.invites.id, F.meet.id, F.link.id];
		const pset = conf.property_sets.find((p) => p && p.id === PSET_EVENT);
		/* Seeded ONCE, like the views: a set the user deletes stays deleted. */
		if (!pset) { if (created) conf.property_sets.push({ id: PSET_EVENT, name: 'Event', member_ids: pageFields }); }
		else {
			/* keep the set pointing at whichever status field is active, and pick
			 * up fields added after the set was first created */
			pset.member_ids = (pset.member_ids || []).filter((id) => id !== F.status.id && id !== F.astatus.id);
			if (!pset.member_ids.includes(statusFieldId)) pset.member_ids.push(statusFieldId);
			for (const id of pageFields) if (!pset.member_ids.includes(id)) pset.member_ids.push(id);
		}
		for (const v of conf.views) {
			if (!Array.isArray(v.field_ids)) continue;
			const had = v.field_ids.includes(F.status.id) || v.field_ids.includes(F.astatus.id);
			v.field_ids = v.field_ids.filter((id) => id !== F.status.id && id !== F.astatus.id);
			if (had) v.field_ids.push(statusFieldId);
		}
		/* Only on creation: re-applying it turned the user's Filled-in choice
		 * back into Event on every sync. */
		if (created && (!conf.property_set_default || conf.property_set_default === 'filled')) conf.property_set_default = PSET_EVENT;
		if (created) {
			conf.sidebar_record_sort_field_id = DF.id;
			conf.sidebar_record_sort_dir = 'desc';
		}
		if (oldReleased) await this.flushReleased(oldReleased);
		if (created || JSON.stringify(conf) !== before) {
			await col.saveConfiguration(conf);
		}
		if (pending && !created) {
			const from = [F.when, F.due].find((f) => f.id === pending.from);
			if (from && await this.migrateDates(col, from, DF) !== null) {
				const c2 = col.getConfiguration();
				if (c2.custom && c2.custom.gcalDates) { delete c2.custom.gcalDates; await col.saveConfiguration(c2); }
			}
		}
		if (created || cfg.collectionGuid !== col.getGuid()) await this.saveCfg({ collectionGuid: col.getGuid() });
		this.watchCollection();
		return col;
	}

	/* The date moved to the other property (Settings → Event dates): copy every
	 * page's value across, so nothing is lost and Google sees no change. The
	 * old property is archived, not emptied, so switching back finds it. */
	async migrateDates(col, from, to) {
		const progress = this.progress('Moving dates to ' + to.label);
		let n = 0;
		try {
			for (const r of await col.getAllRecords()) {
				if (this.isTrashed(r)) continue;
				let src = null;
				try { const dt = r.prop(from.label) && r.prop(from.label).datetime(); src = dt ? dt.value() : null; } catch (e) {}
				/* never copy an EMPTY value over a date: that is how a half-done
				 * move would wipe the dates it has not reached yet */
				if (!src) continue;
				const dst = r.prop(to.label);
				/* the new property can take a while to reach the records after
				 * the schema save; the marker brings the next sync back here */
				if (!dst) { this.log('dates: ' + to.label + ' not ready, retrying next sync'); return null; }
				const cur = dst.datetime();
				if (cur && JSON.stringify(cur.value()) === JSON.stringify(src)) continue;
				this.localWrites.set(this.recGuid(r), Date.now());
				await dst.set(src);
				n++;
			}
		} finally {
			if (progress) { try { progress.destroy ? progress.destroy() : progress.remove(); } catch (e) {} }
		}
		this.log('moved dates ' + from.label + ' -> ' + to.label + ' on ' + n + ' pages');
		if (n) this.toast('Moved the dates of ' + n + ' events to ' + to.label + '.');
		return n;
	}

	fieldDef(f) {
		return { id: f.id, label: f.label, type: f.type, icon: f.icon, active: true, many: !!f.many, read_only: false };
	}
	choiceDef(c) { return { id: c.id, label: c.label, icon: '', color: c.color, active: true }; }
	calendarChoiceId(calId) { return 'CGCAL' + this.hash10(calId); }
	calendarChoices(cfg) {
		const out = [];
		let i = 0;
		const seen = new Set();
		for (const [key, c] of Object.entries(cfg.calendars)) {
			if (!c.enabled) { i++; continue; }
			const calId = c.calId || this.parseCalKey(key).calId;
			const cid = this.calendarChoiceId(calId);
			if (seen.has(cid)) continue;
			seen.add(cid);
			out.push(this.choiceDef({ id: cid, label: c.summary || calId, color: i % 15 }));
			i++;
		}
		return out;
	}

	/* Google events whose page MOVED to another collection: never born again,
	 * and the moved page is never written by the sync again (his rule
	 * 2026-10-18: a page moved out is his). Kept in the plugin's OWN synced
	 * config (cfg.released), so a second device does not copy it back.
	 * Measured 2026-10-18 (Timeline thread + here): a save of the COLLECTION's
	 * config reloads every plugin on it (Timeline __tlGen +2, his place lost); a
	 * save of OUR config remounts the views once (mount +1). So nothing is saved
	 * per trash (trash stays per device, state.ignored), and a move is saved
	 * once, queued in localStorage and flushed after the sync that found it. */
	releaseQueue() {
		let q = null;
		try { q = JSON.parse(window.localStorage.getItem(this.k(LS_RELEASEQ)) || 'null'); } catch (e) {}
		return q && Array.isArray(q.add) && Array.isArray(q.remove) ? q : { add: [], remove: [] };
	}
	releasedKeys() {
		const set = new Set(this.cfg().released || []);
		const q = this.releaseQueue();
		for (const k of q.add) set.add(k);
		for (const k of q.remove) set.delete(k);
		return set;
	}
	releaseKeys(add, remove) {
		const q = this.releaseQueue();
		for (const k of add || []) { if (!q.add.includes(k)) q.add.push(k); q.remove = q.remove.filter((x) => x !== k); }
		for (const k of remove || []) { if (!q.remove.includes(k)) q.remove.push(k); q.add = q.add.filter((x) => x !== k); }
		try { window.localStorage.setItem(this.k(LS_RELEASEQ), JSON.stringify(q)); } catch (e) {}
		clearTimeout(this.releaseTimer);
		this.releaseTimer = setTimeout(() => { this.flushReleased().catch(() => {}); }, 3000);
		return Promise.resolve();
	}
	async flushReleased(extra) {
		if (this.destroyed) return;
		const was = this.cfg().released || [];
		const set = this.releasedKeys();
		for (const k of extra || []) set.add(k);
		try { window.localStorage.removeItem(this.k(LS_RELEASEQ)); } catch (e) {}
		if (set.size === was.length && was.every((k) => set.has(k))) return;   // never the same content twice
		await this.saveCfg({ released: [...set] });
	}

	watchCollection() {
		for (const id of this.eventIds) { try { this.events.off(id); } catch (e) {} }
		this.eventIds = [];
		const guid = this.cfg().collectionGuid;
		if (!guid) return;
		try {
			/* A page the user trashes must stay gone: remember its Google key. */
			this.eventIds.push(this.events.on('record.updated', (ev) => {
				const rec = ev.getRecord && ev.getRecord();
				const rguid = rec ? this.recGuid(rec) : (ev.recordGuid || ev.guid);
				if (!rguid) return;
				if (ev.trashed === true) {
					const s = this.state();
					const keys = [];
					for (const [key, g] of Object.entries(s.records)) {
						if (g === rguid) { s.ignored[key] = Date.now(); delete s.records[key]; keys.push(key); }
					}
					/* per device only (state.ignored): a trashed page cannot be read
					 * back, so sharing it would take a synced save per trash, and
					 * every such save remounts the collection's views (Timeline
					 * lost his place on each delete, measured 2026-10-18) */
					this.setState(s);
					return;
				}
				if (ev.trashed === false) return;
				this.queueOutbound(rguid);
			}, { collection: guid }));
			this.eventIds.push(this.events.on('record.created', (ev) => {
				const rec = ev.getRecord && ev.getRecord();
				const rguid = rec ? this.recGuid(rec) : (ev.recordGuid || ev.guid);
				if (rguid) this.queueOutbound(rguid, 4000);
			}, { collection: guid }));
		} catch (e) { /* events API unavailable */ }
		/* People the user trashes are never recreated (an organiser that turned
		 * out to be an organisation, say). Remembered by e-mail and by name. */
		const pguid = this.cfg().persons.collectionGuid;
		if (pguid) {
			try {
				this.eventIds.push(this.events.on('record.updated', (ev) => {
					if (ev.trashed !== true) return;
					const rec = ev.getRecord && ev.getRecord();
					if (!rec) return;
					const s = this.state();
					const name = (rec.getName() || '').trim().toLowerCase();
					const ef = this.cfg().persons.emailField;
					const email = ef ? String(rec.text(ef) || '').trim().toLowerCase() : '';
					if (name) s.ignoredPeople[name] = Date.now();
					if (email) s.ignoredPeople[email] = Date.now();
					this.setState(s);
				}, { collection: pguid }));
			} catch (e) {}
		}
	}

	// ── sync ──────────────────────────────────────────────────────────────────

	schedule(ms) {
		if (this.destroyed) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = null; this.syncNow(false); }, ms);
	}

	async syncNow(manual) {
		if (this.destroyed) return;
		const cfg = this.cfg();
		const enabled = Object.entries(cfg.calendars).filter(([, c]) => c.enabled);
		if (!this.connected() || !enabled.length) {
			/* Keep the schema current even while signed out, so new properties
			 * appear without waiting for a successful sync. */
			if (cfg.collectionGuid) { try { await this.ensureCollection(); } catch (e) {} }
			if (manual) this.toast(this.connected() ? 'No calendars selected. Open Google Calendar: Settings.' : 'Not connected. Open Google Calendar: Settings.');
			this.schedule(60000);
			return;
		}
		if (this.needsSetup()) {
			/* nothing syncs before the first-run choices are made */
			if (manual) this.toast('Finish "Before the first sync" first: Google Calendar: Settings.');
			this.schedule(60000);
			return;
		}
		if (this.syncing) { if (manual) this.toast('Sync already running'); return; }
		this.syncing = true;
		let progress = manual ? this.progress('Syncing with Google') : null;
		try {
			const summary = await this.runSync(enabled);
			this.lastSyncSummary = summary;
			this.lastSyncAt = Date.now();
			if (manual) this.toast(summary);
		} catch (e) {
			console.error('[gcal] sync failed', e);
			if (manual) this.toast('Sync failed: ' + (e.message || e));
		} finally {
			this.syncing = false;
			if (progress) { try { progress.destroy ? progress.destroy() : progress.remove(); } catch (e) {} }
			this.schedule(Math.max(1, Number(cfg.pollMinutes) || 5) * 60000);
		}
	}

	async runSync(enabledCalendars) {
		const cfg = this.cfg();
		this.log('runSync start, collection ' + cfg.collectionGuid);
		const col = await this.ensureCollection();
		const now = new Date();
		const timeMin = new Date(now.getTime() - (Number(cfg.pastDays) || 0) * 86400000);
		const timeMax = new Date(now.getTime() + (Number(cfg.futureDays) || 0) * 86400000);

		/* Index existing pages by Google key so every upsert is idempotent even
		 * when two devices sync the same calendar. */
		const records = await col.getAllRecords();
		const byKey = new Map();
		for (const r0 of records) {
			/* Handles from getAllRecords carry snapshot property values; a page
			 * whose Event ID just changed would index under its OLD id and match
			 * a stale cancellation. Read through a fresh handle. */
			const r = this.data.getRecord(this.recGuid(r0)) || r0;
			if (this.isTrashed(r)) continue;
			const ck = this.parseCalKey(this.readText(r, F.calId.label));
			const eid = this.readText(r, F.eventId.label);
			if (ck && eid) byKey.set(ck.key + '|' + eid, r);
		}
		const people = await this.peopleIndex();
		const state = this.state();
		const released = this.releasedKeys();
		const releaseNow = [], unrelease = [];
		/* a page moved BACK into the collection takes its event with it again */
		for (const k of released) if (byKey.has(k)) { released.delete(k); unrelease.push(k); }
		/* Keep the key -> page memory current for every page found here. A move
		 * out is recognised through this memory only, and a page that came back
		 * (or was first synced on another device) was missing from it, so moving
		 * it out again made a copy (measured 2026-10-18, Book club). */
		{
			let fixed = 0;
			for (const [k, r] of byKey) { const g = this.recGuid(r); if (state.records[k] !== g) { state.records[k] = g; fixed++; } }
			if (fixed) this.setState(state);
		}
		/* An unread index is "not ready", never "no pages": if this device has
		 * synced before and not one page answers with its Event ID, creating
		 * pages now would duplicate every event. Stop instead. */
		if (!byKey.size && Object.keys(state.records || {}).length) {
			throw new Error('none of the synced pages could be read; sync paused to avoid duplicates');
		}
		/* Pages synced before a status mode switch have an empty status field;
		 * fill it from what the other field held (cheap, idempotent). */
		const st = cfg.status || {};
		if (st.mode === 'record' && st.collectionGuid && st.confirmed) {
			for (const r of byKey.values()) {
				const p = this.propById(r, F.astatus.id);
				if (!p || (p.texts() || []).length) continue;
				const old = this.propById(r, F.status.id);
				const wasCancelled = old && old.choice() === STATUS_BY_GOOGLE.cancelled;
				this.localWrites.set(this.recGuid(r), Date.now());
				await this.setStatusFromGoogle(r, wasCancelled ? 'cancelled' : 'confirmed');
			}
		}
		let created = 0, updated = 0, skipped = 0, cancelled = 0;
		const bornNow = [];
		const errors = [];

		const signedIn = this.signedIn();
		const skippedAccounts = new Set();
		for (const [calKey, cal] of enabledCalendars) {
			const ck = this.parseCalKey(calKey);
			if (!ck) continue;
			if (!signedIn.includes(ck.account)) { skippedAccounts.add(ck.account); continue; }
			const calId = ck.calId;
			const events = await this.fetchEvents(ck.account, calId, timeMin, timeMax);
			/* Classify first: a series edit in Google cancels the old instances
			 * and creates a brand-new series. Pairing those cancellations with
			 * unknown new events of the same title (in start order) lets the
			 * existing pages be REUSED — they change date instead of turning
			 * into a Dropped page plus a duplicate. */
			const updates = [], cancels = [], births = [];
			for (const ev of events) {
				const key = calKey + '|' + ev.id;
				let rec = byKey.get(key) || null;
				if (!rec && state.records[key]) {
					/* The remembered page counts only while it holds no event yet
					 * (created, not yet written) or still holds THIS one. A page
					 * that has moved on to another event made the stale key apply
					 * two events to one page every sync (Kian hemma, 2026-09-29);
					 * forget the key and let the event be born. */
					const r = this.data.getRecord(state.records[key]);
					let elsewhere = false;
					try { elsewhere = !!r && r._getRow().pguid !== col.getGuid(); } catch (e) {}
					if (r && !this.isTrashed(r) && elsewhere) {
						/* moved to another collection: the page is his now */
						delete state.records[key]; this.setState(state);
						released.add(key); releaseNow.push(key);
						continue;
					}
					const held = r ? this.readText(r, F.eventId.label) : '';
					if (r && !this.isTrashed(r) && (!held || held === ev.id)) rec = r;
					else if (r && held && held !== ev.id) { delete state.records[key]; this.setState(state); }
				}
				if (ev.status === 'cancelled') {
					/* Cancelled instances arrive as skeletons without a summary;
					 * the page itself knows the title. */
					if (rec) cancels.push({ ev, rec, key, title: this.cleanTitle(this.readText(rec, F.gtitle.label)) });
					continue;
				}
				if (rec) updates.push({ ev, rec, key });
				else if (!state.ignored[key] && !released.has(key)) births.push({ ev, key });
			}
			const startOf = (x) => (x.ev.start && (x.ev.start.dateTime || x.ev.start.date)) || '';
			const byTitle = (list) => {
				const m = new Map();
				for (const x of list) { const t = x.title || this.cleanTitle(x.ev.summary); if (!m.has(t)) m.set(t, []); m.get(t).push(x); }
				for (const l of m.values()) l.sort((a, b) => startOf(a) < startOf(b) ? -1 : 1);
				return m;
			};
			const cByTitle = byTitle(cancels), bByTitle = byTitle(births);
			for (const [title, cList] of cByTitle) {
				const bList = bByTitle.get(title) || [];
				while (cList.length && bList.length) {
					const c = cList.shift(), b = bList.shift();
					b.rebornFrom = c; c.reborn = true;
				}
			}
			for (const { ev, rec, key } of updates) {
				if (this.destroyed) throw new Error('plugin reloaded mid-sync');
				try {
					if (this.readText(rec, F.updated.label) === (ev.updated || '')) { skipped++; continue; }
					await this.applyEvent(rec, ev, calKey, cal, people, false);
					updated++;
				} catch (e) { errors.push({ key, title: ev.summary, error: String(e && e.message || e) }); console.error('[gcal] event failed', key, e); }
			}
			for (const b of births) {
				if (this.destroyed) throw new Error('plugin reloaded mid-sync');
				try {
					if (b.rebornFrom) {
						const rec = b.rebornFrom.rec;
						delete state.records[b.rebornFrom.key];
						state.records[b.key] = this.recGuid(rec);
						this.setState(state);
						byKey.set(b.key, rec);
						await this.applyEvent(rec, b.ev, calKey, cal, people, false);
						updated++;
						continue;
					}
					const guid = col.createRecord(this.cleanTitle(b.ev.summary));
					if (!guid) throw new Error('createRecord failed');
					const rec = await this.awaitRecord(guid);
					if (!rec) throw new Error('created record not found: ' + guid);
					state.records[b.key] = guid;
					this.setState(state);   // before the writes, so a failure can never duplicate the page
					byKey.set(b.key, rec);
					await this.applyEvent(rec, b.ev, calKey, cal, people, true);
					bornNow.push({ guid, which: b.ev.status === 'cancelled' ? 'cancelled' : 'confirmed' });
					try { const items = await rec.getLineItems(); state.born[guid] = { t: Date.now(), lines: (items || []).length }; this.setState(state); } catch (e) {}
					created++;
				} catch (e) { errors.push({ key: b.key, title: b.ev.summary, error: String(e && e.message || e) }); console.error('[gcal] event failed', b.key, e); }
			}
			cancels.sort((a, b) => { const d = (x) => { const dt = x.rec.prop && x.rec.prop(this.dateF().label) && x.rec.prop(this.dateF().label).datetime(); return dt ? dt.value().d : ''; }; return d(a) < d(b) ? -1 : 1; });
			for (const c of cancels) {
				if (c.reborn) { delete state.pendingCancels[c.key]; continue; }
				try {
					const fresh = this.data.getRecord(this.recGuid(c.rec));
					if (!fresh || this.isTrashed(fresh)) { delete state.pendingCancels[c.key]; continue; }
					/* The page may have been reborn onto a new instance id (series
					 * edit); only cancel it while it still IS this instance. */
					if (this.readText(fresh, F.eventId.label) !== c.ev.id) { delete state.pendingCancels[c.key]; continue; }
					/* The replacing event may already have its own sync-created page
					 * (Google often delivers the new series before the old one's
					 * cancellations). Adopt that page's event onto THIS page and
					 * retire the sync-created copy — only when it is provably
					 * untouched; any doubt keeps both pages. */
					if (await this.mergeCancelledInto(fresh, c, calKey, cal, people, state)) { updated++; continue; }
					/* Already cancelled, or a status the user chose: nothing to write,
					 * so nothing to wait for or count (the summary used to report the
					 * same Dropped pages as "N cancelled" every twenty minutes). */
					if (!this.cancelWouldChange(fresh)) { delete state.pendingCancels[c.key]; continue; }
					/* Otherwise wait 5 minutes (one poll) before dropping: the replacement
					 * may simply not have arrived yet. */
					if (!state.pendingCancels[c.key]) { state.pendingCancels[c.key] = Date.now(); this.setState(state); continue; }
					if (Date.now() - state.pendingCancels[c.key] < 5 * 60000) continue;
					delete state.pendingCancels[c.key];
					await this.applyCancelled(fresh); cancelled++;
				} catch (e) { errors.push({ key: c.key, error: String(e && e.message || e) }); }
			}
			for (const g of Object.keys(state.born)) if (Date.now() - state.born[g].t > 24 * 3600000) delete state.born[g];
		}
		this.setState(state);
		if (releaseNow.length || unrelease.length) {
			try { await this.releaseKeys(releaseNow, unrelease); } catch (e) { errors.push({ key: 'released', error: String(e && e.message || e) }); }
			if (releaseNow.length) this.log('released ' + releaseNow.length + ' event(s) whose page moved out');
		}
		/* Global Properties can still land its In Backlog default AFTER our
		 * forced status: when its collection cache is cold it waits on
		 * getAllCollections() holding a record handle read before our write,
		 * which still looks empty (seen 2026-09-29, first birth after a
		 * restart). Re-assert once its ~1 s retry window has passed. */
		if (bornNow.length) setTimeout(async () => {
			for (const b of bornNow) {
				if (this.destroyed) return;
				const r = this.data.getRecord(b.guid);
				if (!r || this.isTrashed(r)) continue;
				this.localWrites.set(b.guid, Date.now());
				try { await this.setStatusFromGoogle(r, b.which, true); } catch (e) {}
			}
		}, 3000);
		if (GC_DEV) window.__gcalErrors = errors;
		if (errors.length) this.toast(errors.length + ' event(s) failed: ' + errors[0].error);
		if (skippedAccounts.size && !this.warnedAccounts) {
			this.warnedAccounts = true;
			this.toast('Not signed in on this device: ' + [...skippedAccounts].join(', ') + '. Their calendars were skipped.');
		}
		return 'Google Calendar: ' + created + ' new, ' + updated + ' updated' + (cancelled ? ', ' + cancelled + ' cancelled' : '') + ' (' + enabledCalendars.length + ' calendar' + (enabledCalendars.length === 1 ? '' : 's') + ')';
	}

	async fetchEvents(account, calId, timeMin, timeMax) {
		const out = [];
		let pageToken = null;
		do {
			const page = await this.gapi(account, '/calendars/' + encodeURIComponent(calId) + '/events', {
				query: {
					/* No orderBy: with orderBy=startTime Google omits cancelled
					 * instances of recurring events, so series edits never reached
					 * us and stale instance pages lingered (Kian hemma, 2026-08-23). */
					singleEvents: true, showDeleted: true, maxResults: 2500,
					timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), pageToken,
				},
			});
			for (const e of page.items || []) out.push(e);
			pageToken = page.nextPageToken || null;
		} while (pageToken);
		return out;
	}

	/* Writes one Google event onto a page. `fresh` = page was just created:
	 * that is the only time the title and the description body are written. */
	async applyEvent(rec, ev, calKey, cal, people, fresh) {
		const calId = this.parseCalKey(calKey).calId;
		this.localWrites.set(this.recGuid(rec), Date.now());
		const oldGTitle = this.readText(rec, F.gtitle.label);
		const gtitle = this.cleanTitle(ev.summary);
		if (!fresh && oldGTitle && rec.getName() === oldGTitle && oldGTitle !== gtitle) {
			/* The user never renamed it, so the page follows Google's rename. */
			await this.setText(rec, 'Title', gtitle);
		}
		await this.setText(rec, F.gtitle.label, gtitle);
		await this.setText(rec, F.calId.label, calKey);
		await this.setText(rec, F.eventId.label, ev.id);
		await this.setText(rec, F.link.label, ev.htmlLink || '');
		await this.setText(rec, F.location.label, ev.location || '');
		await this.setWhen(rec, ev);
		await this.setChoice(rec, F.calendar.label, this.calendarChoiceId(calId));
		await this.setStatusFromGoogle(rec, ev.status === 'cancelled' ? 'cancelled' : 'confirmed', fresh);

		const me = (ev.attendees || []).find((a) => a.self);
		const isOwn = !ev.attendees || !ev.attendees.length || (ev.organizer && ev.organizer.self && !ev.attendees.some((a) => !a.self));
		await this.setChoice(rec, F.response.label, (!isOwn && me && RESPONSE_BY_GOOGLE[me.responseStatus]) || null);

		const guests = [];
		for (const a of ev.attendees || []) {
			if (a.self || a.resource) continue;
			const g = await this.personFor(a, people);
			if (g && !guests.includes(g)) guests.push(g);
		}
		await this.setLinks(rec, F.attendees.label, guests);
		let org = null;
		if (ev.organizer && !ev.organizer.self) org = await this.personFor(ev.organizer, people);
		await this.setLinks(rec, F.organizer.label, org ? [org] : []);

		const vlink = ev.hangoutLink || ((ev.conferenceData && ev.conferenceData.entryPoints) || []).filter((e) => e.entryPointType === 'video').map((e) => e.uri)[0];
		if (vlink && !this.readText(rec, F.meet.label)) await this.setText(rec, F.meet.label, vlink);
		if (fresh) await this.writeDescription(rec, ev.description);
		/* Last: the change marker. Written after everything else so a failure
		 * above leaves the page eligible for another pass. */
		await this.setText(rec, F.updated.label, ev.updated || '');
		this.localWrites.set(this.recGuid(rec), Date.now());
	}

	/* A cancelled instance whose replacement already became its own page:
	 * move the replacement's event onto the old page (which may hold the
	 * user's notes) and trash the freshly sync-created copy — but only when
	 * that copy is provably untouched. Returns true when merged. */
	async mergeCancelledInto(oldRec, c, calKey, cal, people, state) {
		const title = c.title || this.cleanTitle(this.readText(oldRec, F.gtitle.label));
		const candidates = [];
		for (const [guid, info] of Object.entries(state.born)) {
			if (guid === this.recGuid(oldRec)) continue;
			const r = this.data.getRecord(guid);
			if (!r || this.isTrashed(r)) continue;
			if (this.parseCalKey(this.readText(r, F.calId.label)) === null) continue;
			if (this.parseCalKey(this.readText(r, F.calId.label)).key !== calKey) continue;
			if (this.cleanTitle(this.readText(r, F.gtitle.label)) !== title) continue;
			if (r.getName() !== this.readText(r, F.gtitle.label)) continue;   // user renamed it: keep
			const items = await r.getLineItems();
			if ((items || []).length > info.lines) continue;                  // user wrote in it: keep
			candidates.push({ r, guid, when: ((r.prop(this.dateF().label) && r.prop(this.dateF().label).datetime()) || { value: () => ({ d: '' }) }).value().d });
		}
		if (!candidates.length) return false;
		candidates.sort((a, b) => a.when < b.when ? -1 : 1);
		const pick = candidates[0];
		const newEid = this.readText(pick.r, F.eventId.label);
		const ck = this.parseCalKey(this.readText(pick.r, F.calId.label));
		let ev;
		try { ev = await this.gapi(ck.account, '/calendars/' + encodeURIComponent(ck.calId) + '/events/' + encodeURIComponent(newEid)); } catch (e) { return false; }
		if (!ev || ev.status === 'cancelled') return false;
		/* Never adopt an event from the SAME series as the cancellation: that
		 * would steal a still-valid sibling instance's page. */
		const sameSeries = (a, b) => a && b && (a.recurringEventId || a.id) === (b.recurringEventId || b.id);
		if (sameSeries(ev, c.ev)) return false;
		await this.applyEvent(oldRec, ev, calKey, cal, people, false);
		delete state.records[c.key];
		state.records[calKey + '|' + newEid] = this.recGuid(oldRec);
		delete state.born[pick.guid];
		this.setState(state);
		pick.r.trash();
		/* the trash handler will flag the key as user-ignored; it was ours */
		setTimeout(() => { const s2 = this.state(); delete s2.ignored[calKey + '|' + newEid]; s2.records[calKey + '|' + newEid] = this.recGuid(oldRec); this.setState(s2); this.releaseKeys([], [calKey + '|' + newEid]).catch(() => {}); }, 1500);
		this.log('merged cancelled ' + c.ev.id.slice(0, 12) + ' into reused page, retired fresh copy ' + pick.guid.slice(0, 8));
		return true;
	}

	/* Would applyCancelled write anything? Mirrors setStatusFromGoogle. */
	cancelWouldChange(rec) {
		const st = this.cfg().status || {};
		if (st.mode === 'record' && st.collectionGuid) {
			const p = this.propById(rec, F.astatus.id);
			const cur = p ? ((p.texts() || [])[0] || null) : null;
			return cur !== st.cancelled && (!cur || cur === st.confirmed);
		}
		const p = rec.prop(F.status.label);
		return !p || p.choice() !== STATUS_BY_GOOGLE.cancelled;
	}

	async applyCancelled(rec) {
		this.localWrites.set(this.recGuid(rec), Date.now());
		await this.setStatusFromGoogle(rec, 'cancelled');
	}

	propById(rec, fieldId) {
		try { return rec.getAllProperties().find((p) => p.guid === fieldId) || null; } catch (e) { return null; }
	}

	/* Google's confirmed/cancelled onto the status field. With a linked status
	 * collection only the two mapped pages are ever written, and only when the
	 * page still holds one of them (or nothing): a status the user chose, like
	 * Done or Someday, is theirs and stays. A page the sync has just created
	 * has no user choice yet: whatever is there came from a default-value
	 * plugin (Global Properties' In Backlog) racing the sync, so it is
	 * overwritten (force). */
	async setStatusFromGoogle(rec, which, force) {
		const st = this.cfg().status || {};
		if (st.mode === 'record' && st.collectionGuid) {
			const target = which === 'cancelled' ? st.cancelled : st.confirmed;
			const p = this.propById(rec, F.astatus.id);
			if (!p || !target) return;
			const cur = (p.texts() || [])[0] || null;
			if (!force && cur && cur !== st.confirmed && cur !== st.cancelled) return;
			if (cur !== target) await p.set([target]);
			return;
		}
		await this.setChoice(rec, F.status.label, which === 'cancelled' ? STATUS_BY_GOOGLE.cancelled : STATUS_BY_GOOGLE.confirmed);
	}

	/* A page only becomes a Google event while its status is empty or the
	 * "confirmed" page; In Backlog / Someday pages are placeholders in Thymer. */
	statusAllowsCreate(rec) {
		const st = this.cfg().status || {};
		if (!(st.mode === 'record' && st.collectionGuid)) return true;
		const p = this.propById(rec, F.astatus.id);
		const cur = p ? ((p.texts() || [])[0] || null) : null;
		return !cur || cur === st.confirmed;
	}

	async setWhen(rec, ev) {
		const prop = rec.prop(this.dateF().label);
		if (!prop) return;
		let dt = null;
		if (ev.start && ev.start.date) {
			const [y, m, d] = ev.start.date.split('-').map(Number);
			dt = DateTime.dateOnly(y, m - 1, d);
			if (ev.end && ev.end.date) {
				/* Google's all-day end is exclusive; Thymer's range end is inclusive. */
				const end = new Date(Date.UTC(...ev.end.date.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v)));
				end.setUTCDate(end.getUTCDate() - 1);
				const endDt = DateTime.dateOnly(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
				if (ev.end.date !== this.nextDay(ev.start.date)) dt.setRangeEnd(endDt);
			}
		} else if (ev.start && ev.start.dateTime) {
			dt = new DateTime(new Date(ev.start.dateTime));
			if (ev.end && ev.end.dateTime) dt.setRangeEnd(new DateTime(new Date(ev.end.dateTime)));
		}
		if (!dt) { await prop.set([]); return; }
		await prop.set(dt.value());
	}

	/* Google titles can carry line breaks (school schedule feeds do); a page
	 * title is one line. */
	cleanTitle(s) {
		const t = String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' · ');
		return t || '(No title)';
	}

	nextDay(ymd) {
		const [y, m, d] = ymd.split('-').map(Number);
		const t = new Date(Date.UTC(y, m - 1, d + 1));
		return t.toISOString().slice(0, 10);
	}

	async writeDescription(rec, description) {
		const text = this.htmlToText(description || '').trim();
		if (!text) return;
		const cfg = this.cfg();
		try {
			const heading = await rec.createLineItem(null, null, 'heading', [{ type: 'text', text: cfg.descHeading || 'Description' }], null);
			if (heading && heading.setHeadingSize) await heading.setHeadingSize(3);
			await rec.insertFromPlainText(text, heading || null, null);
		} catch (e) {
			console.warn('[gcal] description write failed', e);
		}
	}

	htmlToText(s) {
		if (!s) return '';
		if (!/<[a-z][\s\S]*>/i.test(s)) return s.replace(/\r\n/g, '\n');
		const doc = new DOMParser().parseFromString(
			s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n'), 'text/html');
		return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n');
	}

	// ── people ────────────────────────────────────────────────────────────────

	async peopleIndex() {
		const cfg = this.cfg();
		const out = { col: null, byEmail: new Map(), byName: new Map(), emailField: cfg.persons.emailField || '' };
		if (!cfg.persons.collectionGuid) return out;
		const cols = await this.data.getAllCollections();
		out.col = cols.find((c) => c.getGuid() === cfg.persons.collectionGuid) || null;
		if (!out.col) return out;
		const recs = await out.col.getAllRecords();
		for (const r of recs) {
			if (this.isTrashed(r)) continue;
			const guid = this.recGuid(r);
			const name = (r.getName() || '').trim().toLowerCase();
			if (name && !out.byName.has(name)) out.byName.set(name, guid);
			if (out.emailField) {
				const p = r.prop(out.emailField);
				const vals = p ? (p.texts ? p.texts() : [p.text()]) : [];
				for (const v of vals || []) {
					for (const e of String(v || '').split(/[\s,;]+/)) {
						const em = e.trim().toLowerCase();
						if (em && em.includes('@') && !out.byEmail.has(em)) out.byEmail.set(em, guid);
					}
				}
			}
		}
		return out;
	}

	async personFor(att, people) {
		if (!people.col) return null;
		const email = (att.email || '').trim().toLowerCase();
		const name = (att.displayName || '').trim();
		const ignored = this.state().ignoredPeople;
		if ((email && ignored[email]) || (name && ignored[name.toLowerCase()])) return null;
		if (email && people.byEmail.has(email)) return people.byEmail.get(email);
		if (name && people.byName.has(name.toLowerCase())) {
			const guid = people.byName.get(name.toLowerCase());
			/* Learn the e-mail for next time when the page has none yet. */
			if (email && people.emailField) {
				const r = this.data.getRecord(guid);
				const p = r && r.prop(people.emailField);
				if (p && !(p.text && p.text())) { try { await p.set(email); } catch (e) {} }
				people.byEmail.set(email, guid);
			}
			return guid;
		}
		if (!this.cfg().persons.createMissing) return null;
		const title = name || (email ? email.split('@')[0] : '') || 'Unknown';
		const guid = people.col.createRecord(title);
		if (!guid) return null;
		const r = await this.awaitRecord(guid);
		if (r && email && people.emailField) {
			const p = r.prop(people.emailField);
			if (p) { try { await p.set(email); } catch (e) {} }
		}
		if (email) people.byEmail.set(email, guid);
		if (name) people.byName.set(name.toLowerCase(), guid);
		return guid;
	}

	// ── Thymer → Google ───────────────────────────────────────────────────────

	queueOutbound(guid, delay) {
		if (this.destroyed || !this.connected()) return;
		const mine = this.localWrites.get(guid);
		if (mine && Date.now() - mine < 4000) return;   // our own write echoing back
		if (this.syncing) return;
		if (this.outbound.has(guid)) clearTimeout(this.outbound.get(guid));
		this.outbound.set(guid, setTimeout(() => {
			this.outbound.delete(guid);
			this.pushRecord(guid).catch((e) => {
				console.error('[gcal] push failed', e);
				this.toast('Could not update Google: ' + (e.message || e));
			});
		}, delay || 2000));
	}

	/* Calendar KEY (account|calId) for a Calendar choice; enabled calendars
	 * first, then any known one. */
	calendarKeyForChoice(choiceId) {
		const cals = Object.entries(this.cfg().calendars);
		const hit = cals.find(([k, c]) => c.enabled && this.calendarChoiceId(this.parseCalKey(k).calId) === choiceId)
			|| cals.find(([k]) => this.calendarChoiceId(this.parseCalKey(k).calId) === choiceId);
		return hit ? hit[0] : null;
	}

	/* The page's date property, When or Due Date (Settings → Event dates). */
	dateF() { return this.cfg().dateField === 'due' ? F.due : F.when; }

	calendarWritable(calKey) {
		const c = this.cfg().calendars[calKey];
		return !!c && (c.accessRole === 'owner' || c.accessRole === 'writer');
	}

	/* The page's date (When or Due Date) → Google's start/end. Timed events use
	 * instants; all-day events use dates with Google's exclusive end. */
	googleTimesFor(rec) {
		const p = rec.prop(this.dateF().label);
		const dt = p && p.datetime();
		if (!dt) return null;
		const parts = dt.getParts();
		const end = dt.getRangeEnd();
		const raw = dt.value ? dt.value() : null;
		/* Thymer's picker can leave a range end with a time but no date when
		 * "Set time" is toggled off on a timed range. That is not a value. */
		if (raw && raw.r && raw.r.d === '') return { invalid: true };
		if (parts && typeof parts.hours === 'number') {
			const startD = dt.toDate();
			let endD = end ? end.toDate() : null;
			if (!endD || endD <= startD) endD = new Date(startD.getTime() + 3600000);
			return { start: { dateTime: startD.toISOString() }, end: { dateTime: endD.toISOString() }, timed: true };
		}
		const ymd = (q) => q.year + '-' + String(q.month + 1).padStart(2, '0') + '-' + String(q.day).padStart(2, '0');
		const startS = ymd(parts);
		const endS = this.nextDay(end ? ymd(end.getParts()) : startS);
		return { start: { date: startS }, end: { date: endS }, timed: false };
	}

	sameTimes(a, ev) {
		const g = { start: ev.start || {}, end: ev.end || {} };
		if (a.timed) {
			if (!g.start.dateTime || !g.end.dateTime) return false;
			return Date.parse(g.start.dateTime) === Date.parse(a.start.dateTime) && Date.parse(g.end.dateTime) === Date.parse(a.end.dateTime);
		}
		return g.start.date === a.start.date && g.end.date === a.end.date;
	}

	async pushRecord(guid) {
		if (this.destroyed || this.syncing) return;
		const rec = this.data.getRecord(guid);
		if (!rec || this.isTrashed(rec)) return;
		const cfg = this.cfg();
		const eventId = this.readText(rec, F.eventId.label);
		let ck = this.parseCalKey(this.readText(rec, F.calId.label));
		const choice = rec.prop(F.calendar.label) ? rec.prop(F.calendar.label).choice() : null;
		if (!ck) ck = this.parseCalKey(this.calendarKeyForChoice(choice));
		const calKey = ck ? ck.key : null;
		const calId = ck ? ck.calId : null;
		const account = ck ? ck.account : null;
		if (ck && !this.tokensFor(account)) return;   // that account is not signed in here
		let times = this.googleTimesFor(rec);
		if (times && times.invalid) {
			/* Heal the page from Google rather than push garbage. */
			if (eventId && calId) {
				const ev = await this.gapi(account, '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(eventId)).catch(() => null);
				if (ev && ev.status !== 'cancelled') { this.localWrites.set(guid, Date.now()); await this.setWhen(rec, ev); this.toast('That date was incomplete; restored it from Google.'); }
			}
			return;
		}
		const location = this.readText(rec, F.location.label);
		const respChoice = rec.prop(F.response.label) ? rec.prop(F.response.label).choice() : null;
		const respGoogle = Object.keys(RESPONSE_BY_GOOGLE).find((k) => RESPONSE_BY_GOOGLE[k] === respChoice) || null;

		const meetRaw = this.readText(rec, F.meet.label).trim();
		/* Meet is requested by the palette command (meetRequests) or by typing
		 * "meet" in the property (a url property renders it http://meet). */
		const wantsMeet = this.meetRequests.has(guid) || /^(https?:\/\/)?(www\.)?(google\s*)?meet\/?$/i.test(meetRaw);
		const customLink = !wantsMeet && /^https?:\/\/[^/]+\.[^/]+/i.test(meetRaw) ? meetRaw : null;

		/* A page that came from Google (it has a Google Title) but reads no
		 * Event ID is an unreadable page, not a new one: never insert it. */
		if (!eventId && this.readText(rec, F.gtitle.label)) return;
		if (!eventId) {
			/* A page made in Thymer: becomes a Google event once it has a time
			 * and a calendar (opt-in, writable calendars only). */
			if (!cfg.createInGoogle || !calId || !times) return;
			/* The placeholder rule yields to an explicit meeting-link request:
			 * asking for a Meet link means this meeting is real. */
			if (!this.statusAllowsCreate(rec) && !wantsMeet) return;
			if (!this.calendarWritable(calKey)) { this.warnReadOnly(calKey); return; }
			const body = { summary: rec.getName() || '(No title)', start: times.start, end: times.end };
			if (location) body.location = location;
			const insAtt = await this.attendeesForPush(rec, []);
			if (insAtt) body.attendees = insAtt;
			if (wantsMeet) body.conferenceData = { createRequest: { requestId: this.randomString(24), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
			if (customLink) body.description = customLink;
			const ev = await this.gapi(account, '/calendars/' + encodeURIComponent(calId) + '/events', { method: 'POST', body, query: { sendUpdates: this.sendUpdates(rec), conferenceDataVersion: 1 } });
			if (wantsMeet) await this.adoptMeetLink(rec, ev);
			const people = await this.peopleIndex();
			await this.applyEvent(rec, ev, calKey, cfg.calendars[calKey], people, false);
			const s = this.state(); s.records[calKey + '|' + ev.id] = guid; this.setState(s);
			this.toast('Created in Google: ' + (ev.summary || ''));
			return;
		}

		if (!calId) return;
		let ev;
		try {
			ev = await this.gapi(account, '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(eventId));
		} catch (e) {
			if (e.status === 404 || e.status === 410) return;   // gone in Google; the next sync marks it
			throw e;
		}
		if (ev.status === 'cancelled') return;
		const patch = {};
		if (times && !this.sameTimes(times, ev)) {
			/* PATCH MERGES objects: a timed event made all-day kept its dateTime
			 * beside the new date and Google refused it (found 2026-10-18 on "Fira
			 * Kian 14 år"). Clear the other kind explicitly. */
			const kind = (t) => (t.date ? { date: t.date, dateTime: null, timeZone: null } : { dateTime: t.dateTime, date: null });
			patch.start = kind(times.start); patch.end = kind(times.end);
		}
		if ((ev.location || '') !== (location || '')) patch.location = location || '';
		const me = (ev.attendees || []).find((a) => a.self);
		if (me && respGoogle && me.responseStatus !== respGoogle) {
			patch.attendees = ev.attendees.map((a) => a.self ? Object.assign({}, a, { responseStatus: respGoogle }) : a);
		}
		const wantAtt = await this.attendeesForPush(rec, patch.attendees || ev.attendees || []);
		if (wantAtt) patch.attendees = wantAtt;
		const evLink = ev.hangoutLink || ((ev.conferenceData && ev.conferenceData.entryPoints) || []).filter((e) => e.entryPointType === 'video').map((e) => e.uri)[0];
		if (wantsMeet && !evLink) {
			patch.conferenceData = { createRequest: { requestId: this.randomString(24), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
		} else if (customLink && customLink !== evLink && !(ev.description || '').includes(customLink)) {
			/* (the event's OWN Meet link is not a pasted one: it was appended to
			 * "Parham/Liv" on 2026-10-18 although Google already carries it) */
			/* A pasted meeting link (Zoom etc) rides along in the description, so
			 * invitations carry it. Appended once; the rest of the description is
			 * left alone. */
			patch.description = (ev.description ? ev.description + '\n\n' : '') + customLink;
		}
		if (!Object.keys(patch).length) return;
		if (!this.calendarWritable(calKey)) { this.warnReadOnly(calKey); return; }
		const updated = await this.gapi(account, '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(eventId), { method: 'PATCH', body: patch, query: { sendUpdates: this.sendUpdates(rec), conferenceDataVersion: 1 } });
		if (patch.conferenceData) await this.adoptMeetLink(rec, updated);
		const people = await this.peopleIndex();
		await this.applyEvent(rec, updated, calKey, cfg.calendars[calKey], people, false);
		this.log('pushed ' + Object.keys(patch).join(',') + ' for ' + eventId);
	}

	/* Per-event override: the "Invitations" choice on the page beats the global
	 * setting, so one meeting can be documented quietly while another invites. */
	attendeesModeFor(rec) {
		const p = rec.prop(F.invites.label);
		const choice = p ? p.choice() : null;
		if (choice && INVITE_MODE_BY_CHOICE[choice] !== undefined) return INVITE_MODE_BY_CHOICE[choice];
		return this.cfg().attendeesPush === 'invite' ? 'invite' : 'off';
	}
	sendUpdates(rec) { return this.attendeesModeFor(rec) === 'invite' ? 'all' : 'none'; }

	/* The Attendees property → a Google attendees list, when the user opted in.
	 * Returns null when nothing should change. Keeps the self entry (and its
	 * response) and the responseStatus of guests that stay; guests removed in
	 * Thymer are removed from the event. */
	async attendeesForPush(rec, current) {
		const cfg = this.cfg();
		const mode = this.attendeesModeFor(rec);
		if (mode !== 'invite') return null;
		const ef = cfg.persons.emailField;
		if (!cfg.persons.collectionGuid || !ef) return null;
		const p = rec.prop(F.attendees.label);
		if (!p) return null;
		const emails = [];
		for (const g of p.texts() || []) {
			const person = this.data.getRecord(g);
			const em = person ? String(person.text(ef) || '').split(/[\s,;]+/).find((x) => x.includes('@')) : null;
			if (em) emails.push(em.toLowerCase());
		}
		const keep = (current || []).filter((a) => a.self || a.resource || emails.includes((a.email || '').toLowerCase()));
		const have = new Set(keep.map((a) => (a.email || '').toLowerCase()));
		for (const em of emails) if (!have.has(em)) keep.push({ email: em });
		const curNonSelf = (current || []).filter((a) => !a.self && !a.resource).map((a) => (a.email || '').toLowerCase()).sort();
		const nextNonSelf = keep.filter((a) => !a.self && !a.resource).map((a) => (a.email || '').toLowerCase()).sort();
		if (JSON.stringify(curNonSelf) === JSON.stringify(nextNonSelf)) return null;
		return keep;
	}

	/* After asking Google for a Meet link, put the real URL on the page (the
	 * property held the word "meet"). Polls briefly: link creation is async. */
	async adoptMeetLink(rec, ev) {
		let link = ev.hangoutLink || ((ev.conferenceData && ev.conferenceData.entryPoints) || []).filter((e) => e.entryPointType === 'video').map((e) => e.uri)[0];
		if (!link) {
			for (let i = 0; i < 5 && !link; i++) {
				await new Promise((r) => setTimeout(r, 1500));
				const ck = this.parseCalKey(this.readText(rec, F.calId.label));
				if (!ck) break;
				const fresh = await this.gapi(ck.account, '/calendars/' + encodeURIComponent(ck.calId) + '/events/' + encodeURIComponent(ev.id)).catch(() => null);
				if (fresh) link = fresh.hangoutLink || ((fresh.conferenceData && fresh.conferenceData.entryPoints) || []).filter((e) => e.entryPointType === 'video').map((e) => e.uri)[0];
			}
		}
		this.localWrites.set(this.recGuid(rec), Date.now());
		if (link) await this.setText(rec, F.meet.label, link);
	}

	/* The event page in the focused panel (falls back to any open event page). */
	activeCalendarRecord() {
		const guids = [];
		try {
			const focused = document.querySelector('.focused-panel .panel-heading[data-banner-drop]');
			if (focused) guids.push(focused.getAttribute('data-banner-drop'));
			for (const el of document.querySelectorAll('.panel-heading[data-banner-drop]')) guids.push(el.getAttribute('data-banner-drop'));
		} catch (e) {}
		const colGuid = this.cfg().collectionGuid;
		for (const g of guids) {
			const rec = g && this.data.getRecord(g);
			if (rec && !this.isTrashed(rec)) {
				try { if (rec._getRow().pguid === colGuid) return rec; } catch (e) {}
			}
		}
		return null;
	}

	async addMeetingLink(kind) {
		const rec = this.activeCalendarRecord();
		if (!rec) { this.toast('Open an event page in the Calendar collection first.'); return; }
		const current = this.readText(rec, F.meet.label).trim();
		if (/^https?:\/\/[^/]+\.[^/]+/i.test(current)) { this.toast('This event already has a meeting link: ' + current); return; }
		if (kind === 'zoom') {
			const z = (this.cfg().zoomLink || '').trim();
			if (!z) { this.toast('Set your personal Zoom link first: Google Calendar: Settings → Meetings & Places.'); return; }
			this.localWrites.delete(this.recGuid(rec));
			await this.setText(rec, F.meet.label, z);
			this.queueOutbound(this.recGuid(rec), 300);
			this.toast('Zoom link added. It rides along in the Google event and its invitations.');
			return;
		}
		const guid = this.recGuid(rec);
		/* Check the preconditions BEFORE touching the property, so a page that
		 * cannot get a link yet is left untouched. */
		const hasEvent = !!this.readText(rec, F.eventId.label);
		const ck = this.parseCalKey(this.readText(rec, F.calId.label)) || this.parseCalKey(this.calendarKeyForChoice(rec.prop(F.calendar.label) ? rec.prop(F.calendar.label).choice() : null));
		if (!hasEvent) {
			if (!rec.prop(this.dateF().label) || !rec.prop(this.dateF().label).datetime()) { this.toast('Set ' + this.dateF().label + ' (date and time) first, then run the command again.'); return; }
			if (!ck) { this.toast('Set Calendar first, then run the command again.'); return; }
		}
		if (ck && !this.calendarWritable(ck.key)) { this.toast('"' + ((this.cfg().calendars[ck.key] || {}).summary || ck.calId) + '" is read-only in Google, so no Meet link can be created.'); return; }
		const progress = this.progress('Asking Google for a Meet link');
		this.meetRequests.add(guid);
		try {
			await this.pushRecord(guid);
			const link = this.readText(this.data.getRecord(guid), F.meet.label);
			if (/^https:\/\/meet\.google\.com\//.test(link)) this.toast('Google Meet link added: ' + link);
			else this.toast('Google did not return a Meet link. Check the event in Google Calendar and try again.');
		} catch (e) {
			this.toast('Could not create the Meet link: ' + (e.message || e));
		} finally {
			this.meetRequests.delete(guid);
			if (progress) { try { progress.destroy ? progress.destroy() : progress.remove(); } catch (e) {} }
		}
	}

	warnReadOnly(calKey) {
		if (this.warnedReadOnly[calKey]) return;
		this.warnedReadOnly[calKey] = true;
		const c = this.cfg().calendars[calKey];
		this.toast('"' + ((c && c.summary) || calKey) + '" is read-only in Google; your change stays in Thymer only.');
	}

	// ── property helpers ──────────────────────────────────────────────────────

	/* createRecord returns the guid before the row is readable; poll for it. */
	async awaitRecord(guid) {
		for (let i = 0; i < 40; i++) {
			const r = this.data.getRecord(guid);
			if (r) return r;
			await new Promise((res) => setTimeout(res, 50));
		}
		return null;
	}

	recGuid(r) { try { return r._getRow().guid; } catch (e) { return null; } }
	// dlt is a bit field: 2|4 deleted, 8 trashed, 1 resurrected (live), so only 14 means gone
	isTrashed(r) { try { const row = r._getRow(); return !!((row.dlt & 14) || row.trashed); } catch (e) { return false; } }
	readText(rec, label) {
		try { const p = rec.prop(label); if (!p) return ''; const v = p.text(); return v == null ? '' : String(v); } catch (e) { return ''; }
	}
	async setText(rec, label, value) {
		const p = rec.prop(label);
		if (!p) return;
		const cur = p.text();
		if ((cur == null ? '' : String(cur)) === (value || '')) return;
		await p.set(value ? [value] : []);
	}
	async setChoice(rec, label, choiceId) {
		const p = rec.prop(label);
		if (!p) return;
		const cur = p.choice();
		if ((cur || null) === (choiceId || null)) return;
		if (!choiceId) await p.set([]);
		else await p.setChoice(choiceId);
	}
	async setLinks(rec, label, guids) {
		const p = rec.prop(label);
		if (!p) return;
		const cur = p.texts() || [];
		if (cur.length === guids.length && cur.every((g, i) => g === guids[i])) return;
		await p.set(guids);
	}

	// ── settings dialog ───────────────────────────────────────────────────────

	/* FIRST RUN (his design 2026-10-18, canvas "Before the first sync"): after
	 * the first Google sign-in three choices are made before anything syncs, so
	 * Attendees and Organizer never land unlinked without the user knowing.
	 * Shown only until the collection exists; everything stays editable in
	 * Settings, and an install that already synced never sees it. */
	needsSetup() { const c = this.cfg(); return !c.collectionGuid && !c.setupDone && c.accounts.length > 0; }

	async openSetup() {
		this.closeSettings();
		const cfg = this.cfg();
		const esc = (s) => this.ui.htmlEscape(String(s == null ? '' : s));
		const ico = (n) => '<span class="ti ' + n + '"></span>';
		const back = document.createElement('div');
		back.className = 'gc-backdrop';
		back.addEventListener('pointerdown', (e) => { e.preventDefault(); this.closeSettings(); });
		document.body.appendChild(back);
		const box = document.createElement('div');
		box.className = 'gc-modal gc-setup';
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-label', 'Before the first sync');
		const cols = (await this.data.getAllCollections()).filter((c) => !c.isJournalPlugin())
			.map((c) => ({ value: c.getGuid(), label: c.getName(), icon: (c.getConfiguration() || {}).icon, api: c }))
			.sort((a, b) => a.label.localeCompare(b.label));
		const card = (name, value, title, sub) => '<label class="gc-card"><input type="radio" name="' + name + '" value="' + value + '"><span class="gc-card-dot"></span>'
			+ '<span class="gc-card-text"><span class="gc-card-title">' + title + '</span><span class="gc-card-sub">' + sub + '</span></span></label>';
		const step = (n, key, title, lead, extra) => '<div class="gc-step-head"><span class="gc-badge" data-badge="' + key + '">' + n + '</span>'
			+ '<div class="gc-step-text"><h2>' + title + '</h2><p>' + lead + '</p></div>' + (extra || '') + '</div>';
		box.innerHTML = '<div class="gc-head"><div class="gc-head-icon">' + ico('ti-calendar-event') + '</div>'
			+ '<div class="gc-head-text"><h3>Before the first sync</h3><p>Signed in as ' + esc(cfg.accounts.join(', ')) + '. Three choices, then your events come in. All of them can be changed later in Settings.</p></div>'
			+ '<button type="button" class="gc-iconbtn gc-close" aria-label="Close">' + ico('ti-x') + '</button></div>'
			+ '<div class="gc-content">'
			+ '<div class="gc-step">' + step(1, 'cal', 'Calendars', 'Which calendars sync into your ' + esc(cfg.collectionName || 'Calendar') + ' collection.', '<span class="gc-step-count"></span>')
			+ '<div class="gc-box gc-cals"><p class="gc-note">Loading your calendars.</p></div></div>'
			+ '<div class="gc-step">' + step(2, 'people', 'People', 'Attendees and Organizer link to pages in a people collection, matched by e-mail, then by name.')
			+ '<div class="gc-cards gc-cards3">'
			+ card('gc-su-people', 'mine', 'A collection I have', 'Link to the people you already keep.')
			+ card('gc-su-people', 'create', 'Create People', 'A new collection with Name and E-mail.')
			+ card('gc-su-people', 'none', 'Don\'t link people', 'Attendees and Organizer stay empty.')
			+ '</div><div class="gc-box gc-su-mine" hidden>'
			+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">People collection</div></div><button type="button" class="gc-pick gc-w gc-su-pcol" aria-label="People collection"></button></div>'
			+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">E-mail property</div><div class="gc-row-sub">On pages in that collection.</div></div><button type="button" class="gc-pick gc-w gc-su-pemail" aria-label="E-mail property"></button></div>'
			+ '</div></div>'
			+ '<div class="gc-step">' + step(3, 'status', 'Status', 'How confirmed and cancelled events show on their pages.')
			+ '<div class="gc-cards">'
			+ card('gc-su-st', 'builtin', 'Built-in status', 'Confirmed or Cancelled, set by the sync.')
			+ card('gc-su-st', 'record', 'My own status collection', 'A linked property, so events can be ticked off like tasks.')
			+ '</div><div class="gc-box gc-su-stbox" hidden>'
			+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Status collection</div></div><button type="button" class="gc-pick gc-w gc-su-stcol" aria-label="Status collection"></button></div>'
			+ '</div></div>'
			+ '</div>'
			+ '<div class="gc-foot"><span class="gc-setup-note"></span><div class="gc-foot-btns">'
			+ '<button type="button" class="gc-btn gc-ghost gc-cancel">Cancel</button>'
			+ '<button type="button" class="gc-btn gc-primary gc-start" disabled>Start syncing</button></div></div>';
		document.body.appendChild(box);
		this.modalEl = box;
		this.modalBackdrop = back;
		for (const type of ['keydown', 'keypress', 'keyup']) box.addEventListener(type, (e) => { const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) e.stopPropagation(); });
		box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.menuEl) { e.preventDefault(); this.closeSettings(); } });
		box.querySelector('.gc-close').addEventListener('click', () => this.closeSettings());
		box.querySelector('.gc-cancel').addEventListener('click', () => this.closeSettings());
		box.querySelector('input[name="gc-su-st"][value="builtin"]').checked = true;

		/* 2. People */
		const radio = (name) => (box.querySelector('input[name="' + name + '"]:checked') || {}).value || '';
		const pcol = this.picker(box.querySelector('.gc-su-pcol'), { placeholder: 'Choose a collection', onChange: () => { fillEmail(); refresh(); } });
		pcol.set(cols.filter((c) => c.value !== cfg.collectionGuid), '');
		const pemail = this.picker(box.querySelector('.gc-su-pemail'), { placeholder: 'Name only', onChange: () => refresh() });
		const fillEmail = () => {
			const c = cols.find((x) => x.value === pcol.value);
			const fields = c ? (c.api.getConfiguration().fields || []).filter((f) => f.active !== false && (f.type === 'text' || f.type === 'url') && f.id !== 'title' && f.id !== 'icon') : [];
			pemail.set([{ value: '', label: 'Name only' }].concat(fields.map((f) => ({ value: f.label, label: f.label, icon: f.icon || 'ti-mail' }))), (fields.find((f) => /mail/i.test(f.label)) || {}).label || '');
			pemail.disabled = !c;
		};
		fillEmail();
		/* 3. Status */
		const stcol = this.picker(box.querySelector('.gc-su-stcol'), { placeholder: 'Choose a collection', onChange: () => refresh() });
		stcol.set(cols.filter((c) => c.value !== cfg.collectionGuid), '');

		/* 1. Calendars */
		const calsEl = box.querySelector('.gc-cals');
		const calRows = () => [...calsEl.querySelectorAll('.gc-cal')];
		const signedIn = this.signedIn();
		Promise.all(signedIn.map((a) => (this.calendarLists[a] ? Promise.resolve(this.calendarLists[a]) : this.fetchCalendarList(a)).then((l) => [a, l]).catch(() => [a, null]))).then((pairs) => {
			if (this.modalEl !== box) return;
			let html = '';
			for (const [a, list] of pairs) {
				html += '<div class="gc-cal-acct">' + esc(a) + '</div>';
				if (!list) { html += '<p class="gc-note">Could not load the calendars of this account.</p>'; continue; }
				for (const c of list) {
					const ro = !(c.accessRole === 'owner' || c.accessRole === 'writer');
					html += '<label class="gc-cal" data-key="' + esc(this.calKey(a, c.id)) + '" data-account="' + esc(a) + '" data-calid="' + esc(c.id) + '" data-summary="' + esc(c.summaryOverride || c.summary) + '" data-role="' + esc(c.accessRole) + '" data-color="' + esc(c.backgroundColor || '') + '">'
						+ '<input type="checkbox" class="gc-check"' + (c.primary ? ' checked' : '') + '>'
						+ '<span class="gc-dot" style="background:' + esc(c.backgroundColor || '#888') + '"></span>'
						+ '<span class="gc-cal-name">' + esc(c.summaryOverride || c.summary) + '</span>' + (ro ? '<span class="gc-tag">Read-only</span>' : '') + '</label>';
				}
			}
			calsEl.innerHTML = html || '<p class="gc-note">No calendars found.</p>';
			refresh();
		});
		calsEl.addEventListener('change', () => refresh());

		const refresh = () => {
			const on = calRows().filter((r) => r.querySelector('input').checked).length;
			box.querySelector('.gc-step-count').textContent = calRows().length ? on + ' of ' + calRows().length + ' syncing' : '';
			const people = radio('gc-su-people'), st = radio('gc-su-st');
			box.querySelector('.gc-su-mine').hidden = people !== 'mine';
			box.querySelector('.gc-su-stbox').hidden = st !== 'record';
			const peopleOk = people === 'create' || people === 'none' || (people === 'mine' && !!pcol.value);
			const stOk = st === 'builtin' || (st === 'record' && !!stcol.value);
			const badge = (k, ok) => box.querySelector('[data-badge="' + k + '"]').classList.toggle('is-done', ok);
			badge('cal', on > 0); badge('people', peopleOk); badge('status', stOk);
			const missing = [];
			if (!on) missing.push('a calendar');
			if (!peopleOk) missing.push(people === 'mine' ? 'a people collection' : 'people');
			if (!stOk) missing.push('a status collection');
			const note = box.querySelector('.gc-setup-note');
			note.textContent = missing.length ? 'Still to choose: ' + missing.join(', ') + '.' : 'Ready. Your events come in when you start.';
			note.classList.toggle('is-ready', !missing.length);
			box.querySelector('.gc-start').disabled = !!missing.length;
		};
		for (const r of box.querySelectorAll('input[type="radio"]')) r.addEventListener('change', () => refresh());
		refresh();

		box.querySelector('.gc-start').addEventListener('click', async (e) => {
			const btn = e.currentTarget;
			if (btn.disabled) return;
			btn.disabled = true;
			const calendars = {};
			for (const row of calRows()) {
				calendars[row.getAttribute('data-key')] = {
					enabled: row.querySelector('input').checked, summary: row.getAttribute('data-summary'), accessRole: row.getAttribute('data-role'),
					color: row.getAttribute('data-color'), account: row.getAttribute('data-account'), calId: row.getAttribute('data-calid'),
				};
			}
			const people = radio('gc-su-people');
			let persons = { collectionGuid: null, emailField: '', createMissing: false };
			try {
				if (people === 'mine') persons = { collectionGuid: pcol.value, emailField: pemail.value || '', createMissing: true };
				else if (people === 'create') {
					box.querySelector('.gc-setup-note').textContent = 'Creating the People collection.';
					persons = { collectionGuid: await this.createPeopleCollection(), emailField: 'E-mail', createMissing: true };
				}
			} catch (err) {
				box.querySelector('.gc-setup-note').textContent = 'Could not create the People collection: ' + (err.message || err);
				btn.disabled = false;
				return;
			}
			let status = { mode: 'builtin', collectionGuid: null, label: '', confirmed: null, cancelled: null };
			if (radio('gc-su-st') === 'record') {
				const c = cols.find((x) => x.value === stcol.value);
				const recs = c ? (await c.api.getAllRecords()).filter((r) => !this.isTrashed(r)) : [];
				const guess = (re) => { const r = recs.find((x) => re.test(x.getName())); return r ? this.recGuid(r) : null; };
				status = { mode: 'record', collectionGuid: stcol.value, label: c ? c.label : '', confirmed: guess(/in progress|confirmed|active|planned/i), cancelled: guess(/dropped|cancel|archived/i) };
			}
			this.closeSettings();
			await this.saveCfg({ calendars, persons, status, setupDone: true });
			this.syncNow(true);
		});
	}

	/* "Create People" in the first run. A plugin-made collection is re-saved on
	 * a FRESH handle until its name reads back: the first save on a new handle
	 * is clobbered by the default config (playbook rule 11, the "Untitled
	 * Collection" trap). */
	async createPeopleCollection() {
		const col = await this.data.createCollection();
		if (!col) throw new Error('Thymer refused to create a collection');
		const guid = col.getGuid();
		const EMAIL = { id: 'FGCALPEMAIL0001', label: 'E-mail', type: 'text', icon: 'ti-mail', active: true, many: false, read_only: false };
		for (let i = 0; i < 10; i++) {
			const c = (await this.data.getAllCollections()).find((x) => x.getGuid() === guid) || col;
			const conf = c.getConfiguration();
			if (conf.name === 'People' && (conf.fields || []).some((f) => f.id === EMAIL.id)) return guid;
			conf.name = 'People'; conf.item_name = 'Person'; conf.icon = 'ti-users';
			conf.fields = conf.fields || [];
			if (!conf.fields.some((f) => f.id === EMAIL.id)) conf.fields.push(EMAIL);
			await c.saveConfiguration(conf);
			await new Promise((r) => setTimeout(r, 400));
		}
		return guid;
	}

	async openSettings() {
		if (this.needsSetup()) return this.openSetup();
		this.closeSettings();
		const cfg = this.cfg();
		const connected = this.connected();
		const signedIn = this.signedIn();

		const back = document.createElement('div');
		back.className = 'gc-backdrop';
		back.addEventListener('pointerdown', (e) => { e.preventDefault(); this.closeSettings(); });
		document.body.appendChild(back);

		const box = document.createElement('div');
		box.className = 'gc-modal';
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-label', 'Google Calendar settings');
		const esc = (s) => this.ui.htmlEscape(String(s == null ? '' : s));
		const ico = (n, fb) => '<span class="ti ' + (/^ti-[a-z0-9-]+$/.test(n || '') ? n : (fb || 'ti-notes')) + '"></span>';

		const cols = await this.data.getAllCollections();
		const colItems = cols
			.filter((c) => !c.isJournalPlugin() && c.getGuid() !== cfg.collectionGuid)
			.map((c) => ({ value: c.getGuid(), label: c.getName(), icon: (c.getConfiguration() || {}).icon }))
			.sort((a, b) => a.label.localeCompare(b.label));
		const eventsCol = cols.find((c) => c.getGuid() === cfg.collectionGuid);

		const section = this.settingsSection || 'accounts';
		const NAV = [
			['accounts', 'ti-calendar', 'Accounts &amp; Calendars', 'Accounts'],
			['sync', 'ti-refresh', 'Sync'],
			['status', 'ti-stopwatch', 'Status'],
			['meetings', 'ti-video', 'Meetings &amp; Places', 'Meetings'],
			['people', 'ti-users', 'People'],
			['advanced', 'ti-adjustments', 'Advanced'],
		];
		const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
		const pane = (id, title, lead, inner) => '<section class="gc-pane' + (id === section ? ' is-on' : '') + '" data-pane="' + id + '">'
			+ '<div><h2>' + title + '</h2><p class="gc-pane-lead">' + lead + '</p></div>' + inner + '</section>';
		const sw = (cls, on, label) => '<label class="gc-switch"><input type="checkbox" class="' + cls + '"' + (on ? ' checked' : '') + ' aria-label="' + esc(label) + '"><span></span></label>';
		const pick = (cls, extra) => '<button type="button" class="gc-pick gc-w ' + cls + '"' + (extra || '') + '></button>';

		const accounts = cfg.accounts.length
			? '<div class="gc-box">' + cfg.accounts.map((a) => {
				const here = signedIn.includes(a);
				return '<div class="gc-row gc-acct-row" data-account="' + esc(a) + '">'
					+ '<div class="gc-avatar" style="background:hsl(' + hue(a) + ' 32% 26%)">' + esc(a.charAt(0).toUpperCase()) + '</div>'
					+ '<div class="gc-row-text"><div class="gc-row-title">' + esc(a) + '</div>'
					+ '<div class="gc-row-sub' + (here ? '' : ' is-warn') + '">' + (here ? 'Signed in on this device' : 'Not signed in on this device') + '</div></div>'
					+ (here ? '' : '<button type="button" class="gc-btn gc-primary gc-connect">Sign In</button>')
					+ '<button type="button" class="gc-btn gc-disconnect">Disconnect</button></div>';
			}).join('') + '</div>'
			: '<p class="gc-note">No Google account connected yet.</p>';

		box.innerHTML = '<div class="gc-head"><div class="gc-head-icon">' + ico('ti-calendar-event') + '</div>'
			+ '<div class="gc-head-text"><h3>Google Calendar</h3><p>Events sync into the <b>' + esc(eventsCol ? eventsCol.getName() : cfg.collectionName) + '</b> collection'
			+ (eventsCol ? '' : ' (created on the first sync)') + '. Page titles stay yours; Google\'s title lives in its own property.</p></div>'
			+ '<button type="button" class="gc-iconbtn gc-close" aria-label="Close">' + ico('ti-x') + '</button></div>'
			+ '<div class="gc-body"><nav class="gc-nav" aria-label="Settings sections">'
			+ NAV.map(([id, icon, label, short]) => (id === 'advanced' ? '<div class="gc-nav-sep"></div>' : '')
				+ '<button type="button" data-nav="' + id + '"' + (id === section ? ' class="is-on" aria-current="true"' : '') + '>' + ico(icon)
				+ (short ? '<span class="gc-nav-long">' + label + '</span><span class="gc-nav-short">' + short + '</span>' : label) + '</button>').join('')
			+ '</nav><div class="gc-content">'

			+ pane('accounts', 'Accounts &amp; Calendars', 'Choose which calendars sync into your ' + esc(eventsCol ? eventsCol.getName() : cfg.collectionName) + ' collection.',
				'<div class="gc-group"><div class="gc-cap">Google accounts</div>' + accounts
				+ '<div><button type="button" class="gc-btn gc-soft gc-connect">' + (cfg.accounts.length ? ico('ti-plus') + 'Add Google Account' : 'Connect Google') + '</button></div></div>'
				+ '<div class="gc-group"><div class="gc-cap">Calendars<span class="gc-calcount"></span></div>'
				+ '<div class="gc-box gc-cals"><p class="gc-note">' + (connected ? 'Loading calendars' : 'Connect an account to choose calendars.') + '</p></div>'
				+ '<p class="gc-note">Read-only calendars sync into Thymer, but changes made in Thymer are not sent back to them.</p></div>')

			+ pane('sync', 'Sync', 'What comes in from Google, and what goes back.',
				'<div class="gc-group"><div class="gc-cap">From Google</div><div class="gc-box">'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Sync window</div><div class="gc-row-sub">Events outside the window are left alone. Full history is never pulled in.</div></div>'
				+ '<div class="gc-inline"><input class="gc-input gc-num gc-past" type="number" min="0" max="365" aria-label="Days back" value="' + esc(cfg.pastDays) + '"><span>days back</span>'
				+ '<input class="gc-input gc-num gc-future" type="number" min="1" max="730" aria-label="Days ahead" value="' + esc(cfg.futureDays) + '"><span>ahead</span></div></div>'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Check Google every</div><div class="gc-row-sub">Save &amp; Sync Now checks at once.</div></div>'
				+ '<div class="gc-inline"><input class="gc-input gc-num gc-poll" type="number" min="1" max="120" aria-label="Minutes between checks" value="' + esc(cfg.pollMinutes) + '"><span>minutes</span></div></div>'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Event dates</div><div class="gc-row-sub gc-datef-sub"></div></div>'
				+ '<div class="gc-seg gc-datef" role="group" aria-label="Event dates">'
				+ '<button type="button" data-v="when"' + (cfg.dateField !== 'due' ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') + '>When</button>'
				+ '<button type="button" data-v="due"' + (cfg.dateField === 'due' ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') + '>Due Date</button></div></div>'
				+ '</div></div>'
				+ '<div class="gc-group"><div class="gc-cap">Back to Google</div><div class="gc-box">'
				+ '<div class="gc-row" style="flex-wrap:nowrap"><div class="gc-row-text"><div class="gc-row-title">Create Google events from Thymer pages</div>'
				+ '<div class="gc-row-sub">A page with a date and Calendar set becomes a Google event. Changes to its date, Location and My Response are sent to Google; titles never are.</div></div>'
				+ sw('gc-create', cfg.createInGoogle, 'Create Google events from Thymer pages') + '</div>'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Invitations to attendees you add</div><div class="gc-row-sub">One event can differ through its Invitations property.</div></div>'
				+ '<div class="gc-seg gc-attpush" role="group" aria-label="Invitations">'
				+ '<button type="button" data-v="off"' + (cfg.attendeesPush !== 'invite' ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') + '>Don\'t send</button>'
				+ '<button type="button" data-v="invite"' + (cfg.attendeesPush === 'invite' ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') + '>Send</button></div></div>'
				+ '</div></div>')

			+ pane('status', 'Status', 'How confirmed and cancelled events show on their pages.',
				'<div class="gc-cards">'
				+ '<label class="gc-card"><input type="radio" name="gc-stmode" class="gc-stmode" value="builtin"' + (cfg.status.mode !== 'record' ? ' checked' : '') + '><span class="gc-card-dot"></span>'
				+ '<span class="gc-card-text"><span class="gc-card-title">Built-in status</span><span class="gc-card-sub">Confirmed or Cancelled, set by the sync.</span></span></label>'
				+ '<label class="gc-card"><input type="radio" name="gc-stmode" class="gc-stmode" value="record"' + (cfg.status.mode === 'record' ? ' checked' : '') + '><span class="gc-card-dot"></span>'
				+ '<span class="gc-card-text"><span class="gc-card-title">My own status collection</span><span class="gc-card-sub">A linked property, so events can be ticked off like tasks.</span></span></label>'
				+ '</div>'
				+ '<div class="gc-group gc-stbox"><div class="gc-box">'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Status collection</div></div>' + pick('gc-stcol', ' aria-label="Status collection"') + '</div>'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">Property name on event pages</div></div>'
				+ '<input class="gc-input gc-w gc-stlabel" aria-label="Property name on event pages" value="' + esc(cfg.status.label || '') + '" placeholder="Action Status"></div>'
				+ '</div>'
				+ '<div class="gc-cap" style="margin-top:10px">From Google to your status</div><div class="gc-box">'
				+ '<div class="gc-row"><div class="gc-map">Confirmed' + ico('ti-arrow-right') + '</div>' + pick('gc-stconf', ' aria-label="Status for confirmed events"') + '</div>'
				+ '<div class="gc-row"><div class="gc-map">Cancelled' + ico('ti-arrow-right') + '</div>' + pick('gc-stcanc', ' aria-label="Status for cancelled events"') + '</div>'
				+ '</div>'
				+ '<p class="gc-note gc-stnote"></p></div>')

			+ pane('meetings', 'Meetings &amp; Places', 'Video links and locations for your events.',
				'<div class="gc-group"><div class="gc-cap">Video meetings</div><div class="gc-box">'
				+ '<div class="gc-row"><div class="gc-tile">' + ico('ti-video') + '</div><div class="gc-row-text"><div class="gc-row-title">Google Meet</div>'
				+ '<div class="gc-row-sub">Run Add Google Meet Link on an event, or type meet in its Meeting Link.</div></div>'
				+ '<span class="gc-ready">' + ico('ti-check') + 'Ready</span></div>'
				+ '<div class="gc-row"><div class="gc-tile">' + ico('ti-video') + '</div><div class="gc-row-text"><div class="gc-row-title">Zoom</div>'
				+ '<div class="gc-row-sub">Add Zoom Link puts your personal meeting room on the event.</div></div></div>'
				+ '<div class="gc-subfield"><label class="gc-field-label" for="gc-zoom-room">Personal meeting room link</label>'
				+ '<input id="gc-zoom-room" class="gc-input gc-zoom" spellcheck="false" placeholder="https://zoom.us/j/1234567890" value="' + esc(cfg.zoomLink || '') + '"></div>'
				+ '</div></div>'
				+ '<div class="gc-group"><div class="gc-cap">Places</div><div class="gc-box">'
				+ '<div class="gc-row" style="flex-wrap:nowrap"><div class="gc-tile">' + ico('ti-location') + '</div><div class="gc-row-text"><div class="gc-row-title">Suggest places while I type a Location</div>'
				+ '<div class="gc-row-sub">Addresses and venues from Geoapify and OpenStreetMap. Free, nothing to set up.</div></div>'
				+ sw('gc-places', cfg.places !== false, 'Suggest places while I type a Location') + '</div>'
				+ '</div></div>')

			+ pane('people', 'People', 'Attendees and organizers link to pages in your people collection, matched by e-mail first, then by name.',
				'<div class="gc-box">'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">People collection</div></div>' + pick('gc-pcol', ' aria-label="People collection"') + '</div>'
				+ '<div class="gc-row"><div class="gc-row-text"><div class="gc-row-title">E-mail property</div><div class="gc-row-sub">On pages in that collection.</div></div>' + pick('gc-pemail', ' aria-label="E-mail property"') + '</div>'
				+ '<div class="gc-row" style="flex-wrap:nowrap"><div class="gc-row-text"><div class="gc-row-title">Create a page for attendees not found</div><div class="gc-row-sub">A person page you trash is never created again.</div></div>'
				+ sw('gc-pcreate', cfg.persons.createMissing, 'Create a page for attendees not found') + '</div>'
				+ '</div>')

			+ pane('advanced', 'Advanced', 'Optional. Leave this empty to sign in through the built-in app.',
				'<div class="gc-group"><div class="gc-cap">Your own Google Cloud project</div><div class="gc-box gc-adv">'
				+ '<div class="gc-field"><label for="gc-oid">Client ID</label><input id="gc-oid" class="gc-input gc-oid" spellcheck="false" value="' + esc(cfg.oauth.clientId || '') + '" placeholder="1234567890-abc.apps.googleusercontent.com"></div>'
				+ '<div class="gc-field"><label for="gc-osec">Client secret</label><input id="gc-osec" class="gc-input gc-osec" type="password" spellcheck="false" value="' + esc(cfg.oauth.clientSecret || '') + '"></div>'
				+ '<div class="gc-field"><span class="gc-field-label">Redirect URI for your OAuth client</span><div class="gc-uri"><code>' + esc(GC_REDIRECT_URI) + '</code>'
				+ '<button type="button" class="gc-iconbtn gc-copyuri" aria-label="Copy redirect URI">' + ico('ti-copy') + '</button></div></div>'
				+ '<div class="gc-warnline">' + ico('ti-alert-triangle') + '<span>Changing these signs every account out. You sign in again with the new client.</span></div>'
				+ '</div></div>')

			+ '</div></div>'
			+ '<div class="gc-foot"><span class="gc-status"></span><div class="gc-foot-btns">'
			+ '<button type="button" class="gc-btn gc-ghost gc-cancel">Cancel</button>'
			+ '<button type="button" class="gc-btn gc-soft gc-sync"' + (connected ? '' : ' disabled') + '>Save &amp; Sync Now</button>'
			+ '<button type="button" class="gc-btn gc-primary gc-save">Save</button></div></div>';
		document.body.appendChild(box);
		this.modalEl = box;
		this.modalBackdrop = back;
		this.setStatus(this.footSummary());

		for (const type of ['keydown', 'keypress', 'keyup']) {
			box.addEventListener(type, (e) => {
				const t = e.target;
				if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) e.stopPropagation();
			});
		}
		box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.menuEl) { e.preventDefault(); this.closeSettings(); } });
		box.querySelector('.gc-close').addEventListener('click', () => this.closeSettings());

		/* Section rail */
		for (const b of box.querySelectorAll('[data-nav]')) b.addEventListener('click', () => {
			const id = b.getAttribute('data-nav');
			this.settingsSection = id;
			for (const x of box.querySelectorAll('[data-nav]')) { const on = x === b; x.classList.toggle('is-on', on); if (on) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current'); }
			for (const p of box.querySelectorAll('[data-pane]')) p.classList.toggle('is-on', p.getAttribute('data-pane') === id);
			box.querySelector('.gc-content').scrollTop = 0;
		});

		/* Event dates */
		let dateField = cfg.dateField === 'due' ? 'due' : 'when';
		const datefSub = () => {
			box.querySelector('.gc-datef-sub').textContent = dateField === 'due'
				? 'Start and end in Due Date, the name Supertask and your other collections use, so a moved page keeps its date.'
				: 'Start and end in one property, When.';
		};
		datefSub();
		for (const b of box.querySelectorAll('.gc-datef button')) b.addEventListener('click', () => {
			dateField = b.getAttribute('data-v');
			for (const x of box.querySelectorAll('.gc-datef button')) { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }
			datefSub();
		});

		/* Invitations */
		let attPush = cfg.attendeesPush === 'invite' ? 'invite' : 'off';
		for (const b of box.querySelectorAll('.gc-attpush button')) b.addEventListener('click', () => {
			attPush = b.getAttribute('data-v');
			for (const x of box.querySelectorAll('.gc-attpush button')) { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }
		});

		box.querySelector('.gc-copyuri').addEventListener('click', () => {
			try { navigator.clipboard.writeText(GC_REDIRECT_URI); this.setStatus('Redirect URI copied.'); } catch (e) {}
		});

		/* People */
		const pcol = this.picker(box.querySelector('.gc-pcol'), { placeholder: 'Choose a collection', onChange: () => fillEmailOptions() });
		pcol.set([{ value: '', label: 'Not linked' }].concat(colItems), cfg.persons.collectionGuid || '');
		const pemail = this.picker(box.querySelector('.gc-pemail'), { placeholder: 'Name only' });
		const fillEmailOptions = () => {
			const c = cols.find((x) => x.getGuid() === pcol.value);
			const fields = c ? (c.getConfiguration().fields || []).filter((f) => f.active !== false && (f.type === 'text' || f.type === 'url') && f.id !== 'title' && f.id !== 'icon') : [];
			const chosen = (pcol.value === cfg.persons.collectionGuid) ? cfg.persons.emailField : (fields.find((f) => /mail/i.test(f.label)) || {}).label || '';
			pemail.set([{ value: '', label: 'Name only' }].concat(fields.map((f) => ({ value: f.label, label: f.label, icon: f.icon || 'ti-mail' }))), chosen);
			pemail.disabled = !c;
		};
		fillEmailOptions();

		/* Status */
		const stModes = [...box.querySelectorAll('.gc-stmode')];
		const stBox = box.querySelector('.gc-stbox');
		const stLabel = box.querySelector('.gc-stlabel');
		const stNote = box.querySelector('.gc-stnote');
		const stMode = () => (stModes.find((r) => r.checked) || {}).value || 'builtin';
		const refreshStMode = () => { stBox.style.display = stMode() === 'record' ? '' : 'none'; };
		let stRecs = [];
		const refreshStNote = () => {
			const name = (g) => (stRecs.find((r) => r.value === g) || {}).label || '';
			const conf = name(stConf.value);
			const others = stRecs.filter((r) => r.value !== stConf.value && r.value !== stCanc.value).map((r) => r.label).slice(0, 3);
			stNote.textContent = 'The sync only writes these two, and only while a page still holds one of them. '
				+ (others.length ? others.join(', ') + ' and your other statuses stay as you set them' : 'Other statuses stay as you set them')
				+ (conf ? ', and such a page is not created in Google until you set it to ' + conf + '.' : '.');
		};
		const stCol = this.picker(box.querySelector('.gc-stcol'), { placeholder: 'Choose a collection', onChange: () => { stLabel.value = ''; fillStatusPages(); } });
		const stConf = this.picker(box.querySelector('.gc-stconf'), { placeholder: 'Choose a status', onChange: refreshStNote });
		const stCanc = this.picker(box.querySelector('.gc-stcanc'), { placeholder: 'Choose a status', onChange: refreshStNote });
		stCol.set(colItems, cfg.status.collectionGuid || '');
		const fillStatusPages = async () => {
			const c = cols.find((x) => x.getGuid() === stCol.value);
			const keep = stCol.value === cfg.status.collectionGuid;
			if (!stLabel.value.trim() && c) stLabel.value = c.getName();
			const colIcon = c ? (c.getConfiguration() || {}).icon : null;
			const recIcon = (r) => { try { const p = r.prop('Icon'); const t = p && (p.texts() || [])[0]; return t || colIcon; } catch (e) { return colIcon; } };
			stRecs = c ? (await c.getAllRecords()).filter((r) => !this.isTrashed(r)).map((r) => ({ value: this.recGuid(r), label: r.getName(), icon: recIcon(r) })).sort((a, b) => a.label.localeCompare(b.label)) : [];
			const guess = (re) => (stRecs.find((r) => re.test(r.label)) || {}).value || '';
			stConf.set(stRecs, keep && cfg.status.confirmed ? cfg.status.confirmed : guess(/in progress|confirmed|active|planned/i));
			stCanc.set(stRecs, keep && cfg.status.cancelled ? cfg.status.cancelled : guess(/dropped|cancel|archived/i));
			stConf.disabled = stCanc.disabled = !c;
			refreshStNote();
		};
		refreshStMode();
		fillStatusPages();
		for (const r of stModes) r.addEventListener('change', refreshStMode);

		/* Calendars */
		const calsEl = box.querySelector('.gc-cals');
		const countEl = box.querySelector('.gc-calcount');
		const refreshCount = () => {
			const all = calsEl.querySelectorAll('.gc-cal input');
			const on = [...all].filter((i) => i.checked).length;
			countEl.textContent = all.length ? on + ' of ' + all.length + ' syncing' : '';
		};
		calsEl.addEventListener('change', refreshCount);
		const selectedCalendars = () => {
			const out = {};
			for (const row of calsEl.querySelectorAll('.gc-cal')) {
				const key = row.getAttribute('data-key');
				out[key] = {
					enabled: row.querySelector('input').checked,
					summary: row.getAttribute('data-summary'),
					accessRole: row.getAttribute('data-role'),
					color: row.getAttribute('data-color'),
					account: row.getAttribute('data-account'),
					calId: row.getAttribute('data-calid'),
				};
			}
			/* keep calendars we know about but could not list this time (other
			 * accounts, or Google did not return them) */
			for (const [key, c] of Object.entries(cfg.calendars)) if (!out[key]) out[key] = c;
			return out;
		};
		const calRow = (key, c, on, note) => {
			const ro = !(c.accessRole === 'owner' || c.accessRole === 'writer');
			return '<label class="gc-cal" data-key="' + esc(key) + '" data-account="' + esc(c.account) + '" data-calid="' + esc(c.calId) + '" data-summary="' + esc(c.summary) + '" data-role="' + esc(c.accessRole) + '" data-color="' + esc(c.color || '') + '">'
				+ '<input type="checkbox" class="gc-check"' + (on ? ' checked' : '') + '>'
				+ '<span class="gc-dot" style="background:' + esc(c.color || '#888') + '"></span>'
				+ '<span class="gc-cal-name">' + esc(c.summary) + '</span>'
				+ (note ? '<span class="gc-tag">' + esc(note) + '</span>' : (ro ? '<span class="gc-tag">Read-only</span>' : '')) + '</label>';
		};
		const renderCalendars = (lists) => {
			/* lists: account -> calendarList items (only for accounts signed in here) */
			let html = '';
			for (const a of cfg.accounts) {
				html += '<div class="gc-cal-acct">' + esc(a) + '</div>';
				const list = lists[a];
				if (list) {
					if (!list.length) html += '<p class="gc-note">No calendars found.</p>';
					for (const c of list) {
						const key = this.calKey(a, c.id);
						const known = cfg.calendars[key];
						const on = known ? known.enabled : !!c.primary;
						html += calRow(key, { account: a, calId: c.id, summary: c.summaryOverride || c.summary, accessRole: c.accessRole, color: c.backgroundColor || '' }, on, null);
					}
				} else {
					/* not signed in on this device: show what the settings know */
					const known = Object.entries(cfg.calendars).filter(([, c]) => c.account === a);
					if (!known.length) html += '<p class="gc-note">Sign in on this device to list calendars.</p>';
					for (const [key, c] of known) html += calRow(key, c, c.enabled, 'Not signed in here');
				}
			}
			calsEl.innerHTML = html || '<p class="gc-note">Connect an account to choose calendars.</p>';
			refreshCount();
		};
		if (connected) {
			Promise.all(signedIn.map((a) => (this.calendarLists[a] ? Promise.resolve(this.calendarLists[a]) : this.fetchCalendarList(a)).then((l) => [a, l]).catch((e) => [a, null, e])))
				.then((pairs) => {
					if (this.modalEl !== box) return;
					const lists = {};
					for (const [a, l] of pairs) if (l) lists[a] = l;
					renderCalendars(lists);
					const failed = pairs.filter((p) => !p[1]);
					if (failed.length) this.setStatus('Could not load calendars for ' + failed.map((p) => p[0]).join(', ') + ': ' + (failed[0][2] && failed[0][2].message || ''));
				});
		} else if (cfg.accounts.length) {
			renderCalendars({});
		}

		const collect = () => ({
			calendars: selectedCalendars(),
			pastDays: Math.max(0, parseInt(box.querySelector('.gc-past').value, 10) || 0),
			futureDays: Math.max(1, parseInt(box.querySelector('.gc-future').value, 10) || 90),
			pollMinutes: Math.max(1, parseInt(box.querySelector('.gc-poll').value, 10) || 5),
			createInGoogle: box.querySelector('.gc-create').checked,
			attendeesPush: attPush,
			dateField,
			zoomLink: box.querySelector('.gc-zoom').value.trim(),
			places: box.querySelector('.gc-places').checked,
			status: { mode: stMode(), collectionGuid: stCol.value || null, label: stLabel.value.trim(), confirmed: stConf.value || null, cancelled: stCanc.value || null },
			oauth: { clientId: box.querySelector('.gc-oid').value.trim(), clientSecret: box.querySelector('.gc-osec').value.trim() },
			persons: { collectionGuid: pcol.value || null, emailField: pemail.value || '', createMissing: box.querySelector('.gc-pcreate').checked },
		});

		for (const connectBtn of box.querySelectorAll('.gc-connect')) connectBtn.addEventListener('click', async () => {
			/* Stage what is on screen first: saveConfiguration reloads the plugin
			 * later, and the dialog is re-opened when Google comes back. */
			this.stageCfg(collect());
			this.setStatus('Waiting for Google. Finish signing in in your browser.');
			try { await this.startAuth(); } catch (e) { this.setStatus('Could not start sign-in: ' + (e.message || e)); }
		});
		for (const disc of box.querySelectorAll('.gc-disconnect')) disc.addEventListener('click', async () => {
			const account = disc.closest('.gc-acct-row').getAttribute('data-account');
			this.closeSettings();
			await this.disconnect(account);
			this.openSettings();
		});
		box.querySelector('.gc-cancel').addEventListener('click', () => this.closeSettings());
		const oauthChanged = (next) => (next.oauth.clientId !== (cfg.oauth.clientId || '')) || (next.oauth.clientSecret !== (cfg.oauth.clientSecret || ''));
		box.querySelector('.gc-save').addEventListener('click', async () => {
			const next = collect();
			this.closeSettings();
			if (oauthChanged(next)) { this.setTokens({}); next.accounts = []; next.calendars = {}; this.toast('OAuth client changed: connect your Google account(s) again.'); }
			/* No ensureCollection here: saveCfg reloads the plugin, and this dying
			 * instance saw "No collections loaded yet" and toasted it after every
			 * sign-in. The next instance's first sync (8 s) prepares the collection. */
			await this.saveCfg(next);
		});
		box.querySelector('.gc-sync').addEventListener('click', async () => {
			const next = collect();
			this.closeSettings();
			if (oauthChanged(next)) { this.setTokens({}); next.accounts = []; next.calendars = {}; this.toast('OAuth client changed: connect your Google account(s) again.'); }
			await this.saveCfg(next);
			this.syncNow(true);
		});
	}

	// ── place suggestions (OpenStreetMap / Photon) ─────────────────────────────

	/* While the user types in an event page's Location property, suggest places
	 * from OpenStreetMap (Photon: free, no key, CORS open). Hooked on Thymer's
	 * own property editor: `.page-props-row[data-field-id=<location>]
	 * .prop-edit-text textarea`. Picking writes the value into that textarea and
	 * commits it with Enter, exactly as if typed, so Thymer owns the write. */
	hookPlaces() {
		const sel = '.page-props-row[data-field-id="' + F.location.id + '"] .prop-edit-text textarea';
		const onInput = (e) => {
			const ta = e.target;
			if (!ta || ta.tagName !== 'TEXTAREA' || !ta.matches(sel)) return;
			if (this.cfg().places === false) return;
			this.placesQuery(ta);
		};
		const onKey = (e) => {
			const m = this.placeMenu;
			if (!m || e.target !== m.ta) return;
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				if (!m.items.length) return;
				m.active = e.key === 'ArrowDown' ? Math.min(m.items.length - 1, m.active + 1) : Math.max(-1, m.active - 1);
				this.placesPaint();
			} else if (e.key === 'Enter' && m.active >= 0 && !this.placesCommitting) {
				this.placesPick(m.active);
			} else if (e.key === 'Escape' || e.key === 'Tab') {
				this.placesClose(); return;
			} else return;
			e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
		};
		/* Close only when the Location editor is really gone: Thymer may swap the
		 * textarea for a new one mid-typing, which is not the user leaving. */
		const onBlur = (e) => {
			if (!this.placeMenu || e.target !== this.placeMenu.ta) return;
			setTimeout(() => {
				const m = this.placeMenu;
				if (!m) return;
				const cur = this.placesField();
				if (cur && document.activeElement === cur) { m.ta = cur; this.placesPlace(); return; }
				this.placesClose();
			}, 150);
		};
		document.addEventListener('input', onInput, true);
		window.addEventListener('keydown', onKey, true);
		document.addEventListener('focusout', onBlur, true);
		this.placesOff = () => {
			document.removeEventListener('input', onInput, true);
			window.removeEventListener('keydown', onKey, true);
			document.removeEventListener('focusout', onBlur, true);
			this.placesClose();
		};
	}

	/* Every keystroke may start a search; answers are never thrown away for
	 * being "stale", only superseded by a NEWER answer (seq). Photon takes seconds,
	 * so aborting or discarding on each keystroke meant nothing ever showed while
	 * the user kept typing (2026-09-29). */
	placesQuery(ta) {
		const q = ta.value.trim();
		if (this.placesTimer) clearTimeout(this.placesTimer);
		if (q.length < 3) { this.placesClose(); return; }
		const cached = this.placesCache.get(q);
		if (cached) { this.placesShow(ta, cached, ++this.placesSeq); return; }
		if (!this.placeMenu) this.placesShow(ta, null, 0);   // "Searching" at once
		/* Search while typing, not after a pause: start now if nothing is in
		 * flight; otherwise placesRun re-runs for the latest text when it lands. */
		if (!this.placesBusy) this.placesRun();
	}

	/* One request in flight at a time (Photon throttles bursts and then answers
	 * empty); when it lands, search again for whatever the field says NOW. */
	async placesRun() {
		if (this.placesBusy || this.destroyed) return;
		const ta = this.placesField();
		const q = ta ? ta.value.trim() : '';
		if (q.length < 3) return;
		const cached = this.placesCache.get(q);
		if (cached) { this.placesShow(ta, cached, ++this.placesSeq); return; }
		this.placesBusy = true;
		const seq = ++this.placesSeq;
		let items = null;
		try { items = await this.placesFetch(q); } catch (e) {}
		if (items) this.placesCache.set(q, items);
		this.placesBusy = false;
		if (this.destroyed) return;
		const cur = this.placesField();
		if (!cur || cur.value.trim().length < 3) return;
		if (items && seq >= this.placesShownSeq) this.placesShow(cur, items, seq);
		if (cur.value.trim() !== q) this.placesRun();
	}

	/* Thymer may re-render the editor between keystrokes: always act on the
	 * textarea that is there now. */
	placesField() {
		return document.querySelector('.page-props-row[data-field-id="' + F.location.id + '"] .prop-edit-text textarea');
	}

	placesShow(ta, items, seq) {
		if (items && !items.length) {
			if (seq >= this.placesShownSeq) { this.placesShownSeq = seq; if (this.placeMenu) { this.placeMenu.items = []; this.placeMenu.empty = true; this.placesPaint(); } }
			return;
		}
		if (items) this.placesShownSeq = seq;
		this.placesOpen(ta, items);
	}

	/* Geoapify first (fast, with official address registers), Photon when
	 * Geoapify fails, is throttled, or finds nothing. */
	async placesFetch(q) {
		const bias = this.placesBias();
		try {
			const url = 'https://api.geoapify.com/v1/geocode/autocomplete?limit=8&apiKey=' + GC_GEOAPIFY_KEY + '&text=' + encodeURIComponent(q)
				+ (bias ? '&bias=proximity:' + bias.lon + ',' + bias.lat : '');
			const res = await fetch(url);
			if (res.ok) {
				const items = this.placesItems(await res.json(), 'geoapify');
				if (items.length) return items;
			}
		} catch (e) {}
		const url = 'https://photon.komoot.io/api/?limit=8&q=' + encodeURIComponent(q)
			+ (bias ? '&lat=' + bias.lat + '&lon=' + bias.lon + '&zoom=8&location_bias_scale=0.6' : '');
		const res = await fetch(url);
		if (!res.ok) return null;
		return this.placesItems(await res.json(), 'photon');
	}

	/* Geoapify/Photon features → [{label, sub, lat, lon, src}]: "Name, Street 12, City". */
	placesItems(data, src) {
		const seen = new Set(), out = [];
		for (const f of (data && data.features) || []) {
			const p = f.properties || {};
			const street = [p.street, p.housenumber].filter(Boolean).join(' ');
			const city = p.city || p.town || p.village || p.district || p.county || '';
			const name = p.name && p.name !== street ? p.name : '';
			const parts = [];
			for (const x of [name, street, city]) if (x && !parts.includes(x)) parts.push(x);
			if (!parts.length) continue;
			const label = parts.join(', ');
			if (seen.has(label)) continue;
			seen.add(label);
			const c = (f.geometry && f.geometry.coordinates) || [];
			out.push({ label, sub: [p.postcode, p.country].filter(Boolean).join(' '), lon: c[0], lat: c[1], src });
		}
		return out;
	}

	/* Results lean towards where the user last picked a place (per workspace). */
	placesBias() {
		try { const b = JSON.parse(window.localStorage.getItem(this.k(LS_PLACEBIAS)) || 'null'); return b && isFinite(b.lat) && isFinite(b.lon) ? b : null; } catch (e) { return null; }
	}

	placesOpen(ta, items) {
		let m = this.placeMenu;
		if (!m || m.ta !== ta) {
			const keep = m && m.items;
			this.placesClose(true);
			const el = document.createElement('div');
			el.className = 'gc-menu gc-places';
			el.setAttribute('role', 'listbox');
			el.addEventListener('pointerdown', (e) => {
				e.preventDefault();   // keep the caret in Thymer's field
				const it = e.target.closest('.gc-menu-item');
				if (it) this.placesPick(+it.getAttribute('data-n'));
			});
			el.addEventListener('pointermove', (e) => {
				const it = e.target.closest('.gc-menu-item');
				if (it && this.placeMenu && this.placeMenu.active !== +it.getAttribute('data-n')) { this.placeMenu.active = +it.getAttribute('data-n'); this.placesPaint(); }
			});
			document.body.appendChild(el);
			m = this.placeMenu = { el, ta, items: keep || [], active: -1, empty: false };
		}
		if (items) { m.items = items; m.active = -1; m.empty = false; }
		this.placesPaint();
		this.placesPlace();
	}

	/* From where the user types (the value cell) to the end of the row. */
	placesPlace() {
		const m = this.placeMenu;
		if (!m) return;
		const row = m.ta.closest('.page-props-row') || m.ta;
		const cell = m.ta.closest('.page-prop-val') || m.ta;
		const r = row.getBoundingClientRect();
		const left = cell.getBoundingClientRect().left;
		const w = Math.min(Math.max(r.right - left, 280), window.innerWidth - 16);
		m.el.style.width = w + 'px';
		m.el.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
		m.el.style.top = '';
		m.el.style.bottom = '';
		const below = window.innerHeight - r.bottom - 8;
		if (below < Math.min(m.el.offsetHeight, 300) && r.top > below) m.el.style.bottom = (window.innerHeight - r.top + 4) + 'px';
		else m.el.style.top = (r.bottom + 4) + 'px';
	}

	placesPaint() {
		const m = this.placeMenu;
		if (!m) return;
		const esc = (s) => this.ui.htmlEscape(String(s == null ? '' : s));
		const status = !m.items.length ? '<div class="gc-menu-empty">' + (m.empty ? 'No places found' : 'Searching places') + '</div>' : '';
		m.el.innerHTML = status + '<div class="gc-menu-list">' + m.items.map((it, n) => '<div class="gc-menu-item' + (n === m.active ? ' is-active' : '') + '" role="option" data-n="' + n + '">'
			+ '<span class="ti ti-location"></span><span class="gc-place-text"><span class="gc-place-label">' + esc(it.label) + '</span>'
			+ (it.sub ? '<span class="gc-place-sub">' + esc(it.sub) + '</span>' : '') + '</span></div>').join('')
			+ '</div><div class="gc-places-foot">' + (m.items.length && m.items[0].src === 'geoapify' ? 'Powered by Geoapify · © OpenStreetMap contributors' : 'Places from OpenStreetMap') + '</div>';
	}

	placesPick(n) {
		const m = this.placeMenu;
		const it = m && m.items[n];
		if (!it) return;
		const ta = m.ta.isConnected ? m.ta : this.placesField();
		this.placesClose();
		if (!ta) return;
		try { if (isFinite(it.lat) && isFinite(it.lon)) window.localStorage.setItem(this.k(LS_PLACEBIAS), JSON.stringify({ lat: +it.lat.toFixed(3), lon: +it.lon.toFixed(3) })); } catch (e) {}
		/* Write through Thymer's own editor: value, input, Enter to commit. */
		ta.value = it.label;
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		this.placesCommitting = true;
		try { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); }
		finally { this.placesCommitting = false; }
		this.placesClose();
	}

	placesClose(keepTimer) {
		if (!keepTimer && this.placesTimer) { clearTimeout(this.placesTimer); this.placesTimer = null; }
		if (this.placeMenu) { try { this.placeMenu.el.remove(); } catch (e) {} this.placeMenu = null; }
	}

	/* The footer's last-sync line: "Synced 08:37 · 0 new, 0 updated · 4 calendars". */
	footSummary() {
		const s = String(this.lastSyncSummary || '').replace(/^Google Calendar:\s*/, '');
		if (!s) return '';
		const m = s.match(/^(.*?)\s*\((\d+ calendars?)\)$/);
		const t = this.lastSyncAt ? new Date(this.lastSyncAt) : null;
		const hhmm = t ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') : '';
		return (hhmm ? 'Synced ' + hhmm + ' · ' : '') + (m ? m[1] + ' · ' + m[2] : s);
	}

	/* A button that opens a list with each item's real icon (native selects
	 * cannot show icons). Items: {value, label, icon}. */
	picker(btn, { placeholder, onChange } = {}) {
		let items = [], value = '';
		const esc = (s) => this.ui.htmlEscape(String(s == null ? '' : s));
		const ico = (n) => (/^ti-[a-z0-9-]+$/.test(n || '') ? '<span class="ti ' + n + '"></span>' : '');
		const paint = () => {
			const it = items.find((i) => i.value === value);
			btn.innerHTML = (it && it.value !== '' ? ico(it.icon) + '<span class="gc-pick-label">' + esc(it.label) + '</span>'
				: '<span class="gc-pick-label is-empty">' + esc(it ? it.label : placeholder) + '</span>')
				+ '<span class="ti ti-chevron-down gc-pick-chev"></span>';
		};
		btn.addEventListener('click', () => {
			if (btn.disabled) return;
			this.openMenu(btn, items, value, (v) => { value = v; paint(); if (onChange) onChange(v); });
		});
		paint();
		return {
			set: (list, v) => { items = list || []; value = v || ''; paint(); },
			get value() { return value; },
			set disabled(d) { btn.disabled = !!d; },
		};
	}

	openMenu(anchor, items, value, onPick) {
		this.closeMenu();
		const esc = (s) => this.ui.htmlEscape(String(s == null ? '' : s));
		const menu = document.createElement('div');
		menu.className = 'gc-menu';
		menu.setAttribute('role', 'listbox');
		const searchable = items.length > 8;
		menu.innerHTML = (searchable ? '<input class="gc-menu-search" placeholder="Search" aria-label="Search">' : '') + '<div class="gc-menu-list"></div>';
		document.body.appendChild(menu);
		this.menuEl = menu;
		const list = menu.querySelector('.gc-menu-list');
		const search = menu.querySelector('.gc-menu-search');
		let shown = [], active = 0;
		const draw = () => {
			const q = search ? search.value.trim().toLowerCase() : '';
			shown = items.filter((i) => !q || i.label.toLowerCase().includes(q));
			list.innerHTML = shown.length ? shown.map((i, n) => '<div class="gc-menu-item' + (n === active ? ' is-active' : '') + '" role="option" data-n="' + n + '"'
				+ (i.value === value ? ' aria-selected="true"' : '') + '>'
				+ (/^ti-[a-z0-9-]+$/.test(i.icon || '') ? '<span class="ti ' + i.icon + '"></span>' : '')
				+ '<span>' + esc(i.label) + '</span>' + (i.value === value ? '<span class="ti ti-check gc-menu-check"></span>' : '') + '</div>').join('')
				: '<div class="gc-menu-empty">No matches</div>';
			const a = list.querySelector('.is-active');
			if (a) a.scrollIntoView({ block: 'nearest' });
		};
		active = Math.max(0, items.findIndex((i) => i.value === value));
		draw();
		const r = anchor.getBoundingClientRect();
		menu.style.minWidth = r.width + 'px';
		menu.style.left = Math.min(r.left, window.innerWidth - Math.max(r.width, menu.offsetWidth) - 8) + 'px';
		const below = window.innerHeight - r.bottom - 8;
		if (below < Math.min(menu.offsetHeight, 300) && r.top > below) menu.style.bottom = (window.innerHeight - r.top + 4) + 'px';
		else menu.style.top = (r.bottom + 4) + 'px';
		const choose = (n) => { const it = shown[n]; if (!it) return; this.closeMenu(); onPick(it.value); anchor.focus(); };
		list.addEventListener('pointermove', (e) => { const el = e.target.closest('.gc-menu-item'); if (el) { const n = +el.getAttribute('data-n'); if (n !== active) { active = n; for (const x of list.children) x.classList.toggle('is-active', +x.getAttribute('data-n') === n); } } });
		list.addEventListener('click', (e) => { const el = e.target.closest('.gc-menu-item'); if (el) choose(+el.getAttribute('data-n')); });
		if (search) search.addEventListener('input', () => { active = 0; draw(); });
		const onKey = (e) => {
			if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); draw(); }
			else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); }
			else if (e.key === 'Enter') choose(active);
			else if (e.key === 'Escape') { this.closeMenu(); anchor.focus(); }
			else if (e.key === 'Tab') this.closeMenu();
			else return;
			e.preventDefault(); e.stopPropagation();
		};
		const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) this.closeMenu(); };
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('pointerdown', onDown, true);
		this.menuOff = () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
		if (search) search.focus(); else menu.tabIndex = -1, menu.focus();
	}

	closeMenu() {
		if (this.menuOff) { this.menuOff(); this.menuOff = null; }
		if (this.menuEl) { try { this.menuEl.remove(); } catch (e) {} this.menuEl = null; }
	}

	closeSettings() {
		this.closeMenu();
		if (this.modalEl) { try { this.modalEl.remove(); } catch (e) {} this.modalEl = null; }
		if (this.modalBackdrop) { try { this.modalBackdrop.remove(); } catch (e) {} this.modalBackdrop = null; }
	}

	setStatus(msg) {
		const el = this.modalEl && this.modalEl.querySelector('.gc-status');
		if (el) el.textContent = msg;
		else if (msg) this.toast(msg);
	}

	// ── odds and ends ─────────────────────────────────────────────────────────

	log(msg) {
		try {
			if (!GC_DEV) return;
			const arr = JSON.parse(window.localStorage.getItem('gcal_log') || '[]');
			arr.push(new Date().toISOString() + ' [' + this.instanceId + '] ' + msg);
			window.localStorage.setItem('gcal_log', JSON.stringify(arr.slice(-80)));
		} catch (e) {}
	}

	toast(message) {
		try { this.ui.addToaster({ title: 'Google Calendar', message, dismissible: true, autoDestroyTime: 6000 }); } catch (e) {}
	}
	progress(message) {
		try { return this.ui.addToaster({ title: 'Google Calendar', message, dismissible: false, autoDestroyTime: 120000 }); } catch (e) { return null; }
	}
	randomString(n) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
		const bytes = new Uint8Array(n);
		crypto.getRandomValues(bytes);
		let s = '';
		for (const b of bytes) s += chars[b % chars.length];
		return s;
	}
	base64url(buf) {
		const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}
	fromBase64url(s) {
		const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
		return Uint8Array.from(b, (c) => c.charCodeAt(0));
	}
	hash10(s) {
		/* FNV-1a, rendered as 10 base-36 chars (uppercase). Stable across installs. */
		let h1 = 0x811c9dc5, h2 = 0x01000193;
		for (let i = 0; i < s.length; i++) {
			h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0;
			h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
		}
		return (h1.toString(36) + h2.toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(10, '0').slice(0, 10);
	}
}
