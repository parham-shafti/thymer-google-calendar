// Google Calendar plugin's token relay. Google's token endpoint wants the OAuth client secret even
// with PKCE, and a secret shipped inside plugin code is no secret. So the plugin sends its token
// requests here: the worker adds the secret (GOOGLE_CLIENT_SECRET, set with `wrangler secret put`)
// and forwards them unchanged. It answers only Thymer pages, only for our own client, and only the
// two grants the plugin uses. PKCE still binds every code to the device that started the sign-in.
const GOOGLE_CLIENT_ID = '1047166243922-l7oue40krgd2l3i4iil4g15bgr416mqq.apps.googleusercontent.com';

export default {
	async fetch(req, env) {
		const origin = req.headers.get('Origin') || '';
		const okOrigin = /^https:\/\/[a-z0-9-]+\.thymer\.com$/.test(origin);
		const cors = {
			'Access-Control-Allow-Origin': okOrigin ? origin : 'null',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'content-type',
			'Access-Control-Max-Age': '86400',
			'Vary': 'Origin',
		};
		const reply = (status, text) => new Response(text, { status, headers: cors });
		if (req.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
		if (!okOrigin) return reply(403, 'Forbidden');
		if (req.method !== 'POST' || new URL(req.url).pathname !== '/google/token') return reply(404, 'Not found');
		const form = new URLSearchParams(await req.text());
		const grant = form.get('grant_type');
		if (form.get('client_id') !== GOOGLE_CLIENT_ID || (grant !== 'authorization_code' && grant !== 'refresh_token')) return reply(400, 'Bad request');
		form.set('client_secret', env.GOOGLE_CLIENT_SECRET);
		const res = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		});
		return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': res.headers.get('Content-Type') || 'application/json' } });
	},
};
