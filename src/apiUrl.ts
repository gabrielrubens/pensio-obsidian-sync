/**
 * The Server URL as every request and every link uses it.
 *
 * ⛔ Until 0.7.2 the setting was used as typed, with each call site cleaning
 * it its own way. Two stripped a trailing slash and three did not, so
 * 'https://pensio.app/' opened the right approval page in the browser and
 * then posted the approval to '//api/v1/auth/connect/', which is a 404:
 * every request, refresh and connect failed, and nothing named the URL
 * (review CRIT-3). One of Gabriel's own vaults had exactly that setting.
 */
export const DEFAULT_SERVER_URL = 'https://pensio.app';

/**
 * The setting, trimmed, with a scheme ('pensio.app' means https), no trailing
 * slash, no pasted '/api' or '/api/v1', and no 'www.' (which Cloudflare
 * answers with a redirect). Empty means Pensio. A server on plain http says
 * so: 'http://localhost:8000'.
 */
export function serverUrl(setting: string | undefined | null): string {
    let url = (setting ?? '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/api(\/v\d+)?$/i, '');
    if (!url) return DEFAULT_SERVER_URL;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
    return url.replace('://www.', '://');
}
