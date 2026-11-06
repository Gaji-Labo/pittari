// セッション ID は、Stop hook の登録のファイル名と、承認した宛先の記録のディレクトリ名に使うので、パスの区切りや .. を含む値を受け付けない
export function isValidSessionId(value) {
	return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}
