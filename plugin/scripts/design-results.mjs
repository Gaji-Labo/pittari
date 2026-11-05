import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

// サンドボックスの中の AI に .design-diff の中をリンクへ差し替えられても、リンク先を読み書きしないよう、.design-diff の読み書きはすべてこのモジュールを通す
export class UnsafeResultsPathError extends Error {}

export function isValidResultsDirName(name) {
	return /^[A-Za-z0-9_-]+$/.test(name);
}

// Node には、開いたディレクトリを基準にしてファイルを開く手段（openat）が無いので、代わりにそのディレクトリへ移り、相対パスで開く。
// 深い階層を一度に作ると途中のリンクの先にディレクトリを作ってしまうので、1 階層ずつ作って移り、移るたびに想定したパスにいるかを確かめる
function enterResultsDir(projectDir, segments, { create }) {
	// 登録のファイルに書かれたラベルもここに来るので、.. で .design-diff の外へ出させない
	const invalid = segments.find((segment) => !isValidResultsDirName(segment));
	if (invalid !== undefined) throw new UnsafeResultsPathError(`.design-diff の下のディレクトリ名に使えない名前です: "${invalid}"`);
	try {
		process.chdir(projectDir);
	} catch (error) {
		// Stop hook に渡る cwd は、消した worktree のように既に無いことがある。次の候補のディレクトリを探せるよう、記録が無いものとして扱う
		if (!create && error.code === "ENOENT") return false;
		throw error;
	}
	// realpath は大文字と小文字の違いを実際の名前に直さないので、実際に入ったディレクトリの名前を比較の基準にする
	let expected = process.cwd();
	for (const segment of [".design-diff", ...segments]) {
		expected = join(expected, segment);
		if (create) {
			try {
				mkdirSync(segment);
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
			}
		}
		try {
			process.chdir(segment);
		} catch (error) {
			if (!create && error.code === "ENOENT") return false;
			if (error.code === "ENOTDIR") throw new UnsafeResultsPathError(`${expected} がディレクトリではありません`);
			throw error;
		}
		if (process.cwd() !== expected) {
			if (process.cwd().toLowerCase() === expected.toLowerCase()) {
				throw new UnsafeResultsPathError(`${expected} と大文字・小文字だけが違う ${process.cwd()} が既にあります。--out で別の名前を指定してください`);
			}
			throw new UnsafeResultsPathError(`${expected} がリンクで別の場所（${process.cwd()}）を指しています`);
		}
	}
	return true;
}

// 開く前ではなく開いたファイルを確かめるのは、確かめてから開くまでの間にファイルを差し替えられても、確かめたファイルと読み書きするファイルが食い違わないようにするため。
// ハードリンクは lstat でも普通のファイルに見えるので、リンクの数で見分ける。
// O_NONBLOCK は、名前付きパイプに差し替えられたときに、開く処理で止まらず、普通のファイルでないと判定まで進むために付ける
function openRegularFile(name, flags) {
	let fd;
	try {
		fd = openSync(name, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		if (error.code === "ELOOP") throw new UnsafeResultsPathError(`${join(process.cwd(), name)} がシンボリックリンクです`);
		if (error.code === "ENXIO") throw new UnsafeResultsPathError(`${join(process.cwd(), name)} が普通のファイルではありません`);
		throw error;
	}
	const stats = fstatSync(fd);
	if (!stats.isFile() || stats.nlink !== 1) {
		closeSync(fd);
		throw new UnsafeResultsPathError(`${join(process.cwd(), name)} が普通のファイルではないか、ハードリンクです`);
	}
	return fd;
}

function readRegularFile(name) {
	const fd = openRegularFile(name, constants.O_RDONLY);
	if (fd === null) return null;
	try {
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

// 置き換えで追記すると、同時に終えた 2 つの実行が同じ古い中身に足して書き戻し、先に書いた方の行が消えるので、O_APPEND で書き足す
function appendRegularFile(name, data) {
	const fd = openRegularFile(name, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
	try {
		writeFileSync(fd, data);
	} finally {
		closeSync(fd);
	}
}

// 既存のファイルに書き込むとリンク先を書き換えるので、新しく作ったファイルで置き換える。rename はリンクをたどらずに置き換える
function replaceFile(name, data) {
	const temp = `.${name}.${randomUUID()}.tmp`;
	// wx で作れなかったときは、同じ名前の別のファイルが既にある。それを消さないよう、作る処理は try の外に置く
	const fd = openSync(temp, "wx");
	try {
		try {
			writeFileSync(fd, data);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, name);
	} catch (error) {
		unlinkSync(temp);
		throw error;
	}
}

function inResultsDir(projectDir, segments, options, action) {
	const previous = process.cwd();
	try {
		return enterResultsDir(projectDir, segments, options) ? action() : null;
	} finally {
		process.chdir(previous);
	}
}

export function readResultsFile(projectDir, segments, name) {
	return inResultsDir(projectDir, segments, { create: false }, () => readRegularFile(name));
}

export function writeResultsFiles(projectDir, segments, files) {
	inResultsDir(projectDir, segments, { create: true }, () => {
		for (const [name, data] of Object.entries(files)) replaceFile(name, data);
	});
}

export function appendResultsFile(projectDir, segments, name, data) {
	inResultsDir(projectDir, segments, { create: true }, () => appendRegularFile(name, data));
}

export const INPUTS_DIR = "inputs";

export function readInputFile(projectDir, path) {
	const segments = relative(join(projectDir, ".design-diff", INPUTS_DIR), resolve(projectDir, path)).split(sep);
	const name = segments.pop();
	// inputs の外は .. で始まり、inputs・.design-diff そのものは name が空か .. になる。リンクでないかは readResultsFile が確かめるので、ここではこれらだけを弾く
	if (segments[0] === ".." || name === "" || name === "." || name === "..") {
		throw new UnsafeResultsPathError(`.design-diff/${INPUTS_DIR}/ の下のファイルではないので読みません: ${path}`);
	}
	const text = readResultsFile(projectDir, [INPUTS_DIR, ...segments], name);
	if (text === null) throw new Error(`ファイルがありません: ${path}`);
	return text;
}
