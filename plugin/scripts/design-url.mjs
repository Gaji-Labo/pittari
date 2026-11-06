export const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export function isLocalHostname(hostname) {
	return LOCAL_HOSTNAMES.includes(hostname) || hostname.endsWith(".localhost");
}

export function isLocalDevServerUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	return isLocalHostname(parsed.hostname);
}
