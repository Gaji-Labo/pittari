// サンドボックスの外で動く Chrome に、file: のファイルや外部のページを --url で直接開かせない。
// 開いたあとのリダイレクトの先とページが読み込むリソースの宛先は、design-network.mjs のプロキシサーバーが同じホスト名の規則で絞る。
// 先頭一致で判定すると、http://localhost@example.com のようにユーザー情報の位置に localhost を書いた URL を通してしまう
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
