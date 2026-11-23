#!/usr/bin/env bash
# shellcheck disable=SC2016 # jq programs and Markdown in single quotes: their $ and ` are not the shell's
# Publishing pi-cache-keeper to npm (docs/publishing.md). What publish.yml runs; the owner's Mac can run plan.
# Bash 3.2 (macOS) and later; needs git, jq, node and npm 11.5.1 or later; gh for the commands that read or write
# GitHub.
#
#   publish.sh plan                         the publish guard on HEAD: the version main names, whether npm has it,
#                                           and whether it may be published (exit 4 with the reasons when not)
#   publish.sh archive ID DIGEST INTEGRITY SHA VERSION DEST
#                                           the test job's archive, by its artifact's id and digest: its sha512 is
#                                           INTEGRITY and it ships exactly SHA's files; copied to DEST
#   publish.sh tag VERSION SHA PUBLISHED    the tag v<VERSION> and its GitHub release (DRY_RUN)
#   publish.sh report-publish VERSION RESULT
#                                           the issue of a failed publish, or closes it once npm has VERSION
#
# DRY_RUN: 'no' writes; anything else, unset included, is a dry run. Exit codes: 0 done, 1 an error, 4 a refusal.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
PKG=pi-cache-keeper
REPO=${PUBLISH_REPO:-${GITHUB_REPOSITORY:-ngvoicu/pi-cache-keeper}}
UPSTREAM_URL=${PUBLISH_UPSTREAM_URL:-https://github.com/$REPO.git}
REGISTRY=https://registry.npmjs.org/
# report-publish: how long npm may take to show a version just uploaded, and how often it is asked (seconds).
NPM_SHOW_WAIT=${PUBLISH_NPM_SHOW_WAIT:-900}
NPM_SHOW_POLL=${PUBLISH_NPM_SHOW_POLL:-30}
LABEL=${PUBLISH_LABEL:-publish-bot}
BOT_LOGINS=${PUBLISH_BOT_LOGINS:-github-actions[bot]}
# A plain version: at most six digits a part, so that every number stays far inside Bash's and npm's range.
PLAIN_RE='^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
# What the tarball may hold: these four files and the extension's own modules, top-level .ts files.
PACK_FILES='CHANGELOG.md LICENSE README.md package.json'
LIFECYCLE='preinstall install postinstall prepublish prepare prepublishOnly prepack postpack publish postpublish'

die() {
	echo "publish: $*" >&2
	exit 1
}
say() { echo "publish: $*"; }

# Nothing this script prints becomes a runner command. The markers go to standard error, so that standard output
# carries only what a command prints for its caller (archive: the path, nothing else).
STOP=''
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
	STOP=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
	echo "::stop-commands::$STOP" >&2
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/publish.XXXXXX")
cleanup() {
	rm -rf "${TMP:?}"
	if [[ -n $STOP ]]; then echo "::$STOP::" >&2; fi
}
trap cleanup EXIT

git rev-parse --git-dir >/dev/null 2>&1 || die "not in a git repository"
[[ $NPM_SHOW_WAIT =~ ^[0-9]{1,5}$ ]] || die "PUBLISH_NPM_SHOW_WAIT is not a number of seconds"
[[ $NPM_SHOW_POLL =~ ^[1-9][0-9]{0,3}$ ]] || die "PUBLISH_NPM_SHOW_POLL is not a number of seconds"

# Text for a message: letters, digits and . _ + - only, at most 64 characters.
shown() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._+-' '?' | cut -c1-64; }
# A path from git, for a message: control characters out, cut to 200 characters.
qpath() { printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177' | cut -c1-200; }

# A step output for GitHub Actions (any value, several lines too).
gh_out() {
	[[ -n ${GITHUB_OUTPUT:-} ]] || return 0
	local d="PUBLISH_EOF_$RANDOM$RANDOM"
	{
		echo "$1<<$d"
		printf '%s\n' "$2"
		echo "$d"
	} >>"$GITHUB_OUTPUT"
}

# --- versions ---------------------------------------------------------------------------------------------------
is_plain() { [[ $1 =~ $PLAIN_RE ]]; }

# Only checked plain versions reach arithmetic.
parts() {
	is_plain "$1" || die "internal: '$(shown "$1")' is not a plain version"
	IFS=. read -r P0 P1 P2 <<<"$1"
	P0=$((10#$P0)) P1=$((10#$P1)) P2=$((10#$P2))
}

# ver_cmp A B: -1, 0 or 1.
ver_cmp() {
	local a0 a1 a2
	parts "$1"
	a0=$P0 a1=$P1 a2=$P2
	parts "$2"
	if ((a0 != P0)); then
		if ((a0 > P0)); then echo 1; else echo -1; fi
	elif ((a1 != P1)); then
		if ((a1 > P1)); then echo 1; else echo -1; fi
	elif ((a2 != P2)); then
		if ((a2 > P2)); then echo 1; else echo -1; fi
	else
		echo 0
	fi
}

# The version in COMMIT:package.json when it is plain, else nothing.
version_of() {
	local v
	v=$(git cat-file blob "$1:package.json" 2>/dev/null | jq -r '.version // "" | tostring' 2>/dev/null || true)
	if is_plain "$v"; then echo "$v"; fi
}

# --- npm ---------------------------------------------------------------------------------------------------------
# npm_env ARGS…: npm with an empty environment plus only what it needs: PATH, a throwaway HOME, empty user and
# global configuration, scripts off, the public registry; from a neutral folder. No GH_TOKEN, GITHUB_TOKEN,
# NODE_AUTH_TOKEN, ACTIONS_* or any other variable of the caller reaches npm. Every npm call of this script goes
# through here.
npm_env() {
	mkdir -p "$TMP/npm/home"
	: >"$TMP/npm/user-npmrc"
	: >"$TMP/npm/global-npmrc"
	(cd "$TMP/npm" && env -i PATH="$PATH" HOME="$TMP/npm/home" npm_config_userconfig="$TMP/npm/user-npmrc" \
		npm_config_globalconfig="$TMP/npm/global-npmrc" npm_config_ignore_scripts=true npm_config_registry="$REGISTRY" \
		npm "$@")
}

# need_npm: npm 11.5.1 or later (what trusted publishing needs; npm 10 starts a tree's prepare script on
# pack --dry-run even with --ignore-scripts), else nothing runs.
NPM_MIN=11.5.1
need_npm() {
	local v
	v=$(npm_env --version 2>/dev/null) || die "npm cannot be run (npm $NPM_MIN or later is needed)"
	v=$(printf '%s' "$v" | head -n 1 | LC_ALL=C tr -cd '0-9A-Za-z.+-' | cut -c1-40)
	if [[ ! $v =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || [[ $(ver_cmp "$v" "$NPM_MIN") == -1 ]]; then
		die "npm ${v:-?} is older than $NPM_MIN or not a plain version: use npm $NPM_MIN or later (Node 24)"
	fi
}

npm_neutral() { npm_env "$@" --registry="$REGISTRY"; }

# npm_json ARGS…: npm view … --json; {} when the registry says 404; an error otherwise.
npm_json() {
	local out rc=0
	out=$(npm_neutral view "$@" --json 2>/dev/null) || rc=$?
	if ((rc == 0)) && jq -e 'type == "object"' >/dev/null 2>&1 <<<"$out"; then
		printf '%s\n' "$out"
	elif jq -e '.error.code == "E404"' >/dev/null 2>&1 <<<"$out"; then
		echo '{}'
	else
		die "npm view $(shown "$1") failed (exit $rc)"
	fi
}

# npm_meta: {"dist-tags": …, "time": …} of the package, {} when it does not exist (its first publish).
npm_meta() { npm_json "$PKG" dist-tags time --prefer-online; }

# npm_shows VERSION: npm's metadata lists VERSION. A failed request counts as not yet.
npm_shows() {
	local meta
	meta=$(npm_meta) || return 1
	jq -e --arg v "$1" '(.time // {}) | has($v)' >/dev/null 2>&1 <<<"$meta"
}

# npm_wait_for VERSION: true as soon as npm shows VERSION, asking every NPM_SHOW_POLL seconds for up to
# NPM_SHOW_WAIT seconds. npm lists a new version a while after its upload: asked at once, a publish that worked
# looks like one that failed.
npm_wait_for() {
	local start=$SECONDS n=0
	while :; do
		n=$((n + 1))
		if npm_shows "$1"; then
			((n == 1)) || say "npm shows $PKG $1 (after $((SECONDS - start)) s)"
			return 0
		fi
		if ((SECONDS - start + NPM_SHOW_POLL > NPM_SHOW_WAIT)); then
			say "npm does not show $PKG $1 after $((SECONDS - start)) s ($n requests)"
			return 1
		fi
		((n > 1)) || say "npm does not show $PKG $1 yet: asking again every $NPM_SHOW_POLL s, for up to $NPM_SHOW_WAIT s"
		sleep "$NPM_SHOW_POLL"
	done
}

# npm_githead VERSION: the commit npm recorded for it, or nothing.
npm_githead() {
	# The whole manifest: asked for one field, npm prints a bare value, not an object.
	npm_json "$PKG@$1" | jq -r 'if type == "object" then (.gitHead // "" | tostring) else "" end'
}

# ships_of COMMIT: the files npm packs from COMMIT's tree, sorted, in $TMP/ships. The tree's regular files are
# written out and npm lists them with --dry-run --ignore-scripts from a neutral folder: nothing of the commit runs.
ships_of() {
	rm -rf "${TMP:?}/ships.tree"
	node "$HERE/tarball.mjs" export "$1" "$TMP/ships.tree" || return 1
	if ! npm_neutral pack --dry-run --ignore-scripts --json "$TMP/ships.tree" >"$TMP/ships.json" 2>"$TMP/ships.err"; then
		echo "npm cannot pack the commit $1"
		return 4
	fi
	jq -r '.[0].files[].path' "$TMP/ships.json" | LC_ALL=C sort >"$TMP/ships" || return 1
}

refuse() { printf '%s\n' "$1" >>"$TMP/reasons"; }

# run_check CMD…: a checker that prints refusals and exits 0 (none) or 4 (some); anything else is an error.
run_check() {
	local rc=0
	"$@" >>"$TMP/reasons" || rc=$?
	case $rc in
	0 | 4) ;;
	*) die "a check failed to run (exit $rc)" ;;
	esac
}

# --- plan --------------------------------------------------------------------------------------------------------
# The publish guard. Outputs: version (main's, "!" when not plain), sha, published (npm has it), publish (to do).
cmd_plan() {
	local sha name ver url lat meta s p published=false pc
	[[ ${GITHUB_REF:-refs/heads/main} == refs/heads/main ]] || die "plan runs on refs/heads/main only"
	sha=$(git rev-parse HEAD)
	: >"$TMP/reasons"
	# The version first, from git alone: every outcome, an early refusal included, names it, so notify runs.
	git cat-file blob "$sha:package.json" >"$TMP/p.json" 2>/dev/null || : >"$TMP/p.json"
	ver=$(jq -r '.version // "" | tostring' "$TMP/p.json" 2>/dev/null || true)
	is_plain "$ver" || ver="!"
	gh_out version "$ver"
	gh_out sha "$sha"
	git ls-tree -r --name-only "$sha" >"$TMP/tracked"
	# Before any npm command: no npm configuration in the tree.
	if grep -Eq '(^|/)\.npmrc$' "$TMP/tracked"; then
		gh_out publish false
		say "refused to publish: the tree has an .npmrc; npm is not run on it"
		return 4
	fi
	[[ $ver != "!" ]] || refuse "version: package.json's version is not a plain X.Y.Z"
	meta=$(npm_meta)
	if [[ $ver != "!" ]] && jq -e --arg v "$ver" '(.time // {}) | has($v)' >/dev/null <<<"$meta"; then published=true; fi
	if [[ $published == false ]]; then
		name=$(jq -r '.name // "" | tostring' "$TMP/p.json")
		[[ $name == "$PKG" ]] || refuse "name: package.json says '$(shown "$name")', not $PKG"
		url=$(jq -r 'if (.repository | type) == "object" then .repository.url // "" else .repository // "" end | tostring' "$TMP/p.json")
		[[ $url == "git+https://github.com/$REPO.git" ]] || refuse "repository.url is not git+https://github.com/$REPO.git"
		[[ $(jq -r '.private // false' "$TMP/p.json") == false ]] || refuse "package.json sets private"
		pc=$(jq -c '.publishConfig // {}' "$TMP/p.json")
		[[ $pc == '{}' || $pc == '{"access":"public"}' ]] || refuse "publishConfig: only {\"access\": \"public\"} is allowed"
		if jq -e '[.dependencies, .optionalDependencies, .bundleDependencies, .bundledDependencies] | map(. // {} | length) | add > 0' "$TMP/p.json" >/dev/null; then
			refuse "dependencies: the package declares runtime dependencies; pi provides everything it imports"
		fi
		lat=$(jq -r '(."dist-tags" // {}).latest // "" | tostring' <<<"$meta")
		if [[ -n $lat ]] && is_plain "$ver"; then
			if ! is_plain "$lat" || [[ $(ver_cmp "$ver" "$lat") != 1 ]]; then refuse "version: $ver is not greater than npm's latest"; fi
		fi
		git show "$sha:CHANGELOG.md" >"$TMP/changelog" 2>/dev/null || : >"$TMP/changelog"
		if is_plain "$ver" && ! awk -v h="## [$ver]" 'index($0, h) == 1 { f = 1 } END { exit !f }' "$TMP/changelog"; then
			refuse "CHANGELOG.md: no heading ## [$ver]"
		fi
		for s in $LIFECYCLE; do
			if jq -e --arg s "$s" '(.scripts // {}) | has($s)' "$TMP/p.json" >/dev/null; then refuse "scripts: a lifecycle script '$s'"; fi
		done
		[[ -z $(git status --porcelain) ]] || refuse "the work tree is not the commit (git status shows changes)"
		: >"$TMP/packed"
		if npm_neutral pack --dry-run --ignore-scripts --json "$PWD" 2>"$TMP/pack.err" >"$TMP/pack.json"; then
			jq -r '.[0].files[].path' "$TMP/pack.json" >"$TMP/packed"
		else
			refuse "npm pack --dry-run fails"
		fi
		while IFS= read -r p; do
			grep -Fxq -- "$p" "$TMP/tracked" || refuse "tarball: \`$(qpath "$p")\` is not a tracked file"
			case " $PACK_FILES " in *" $p "*) continue ;; esac
			[[ $p =~ ^[A-Za-z0-9._-]+\.ts$ ]] || refuse "tarball: \`$(qpath "$p")\` is neither a top-level .ts module nor one of the four files"
		done <"$TMP/packed"
		# What pi loads is checked by loading it, in the test job (load.mjs); here only that each registered entry
		# point is in the tarball.
		run_check node "$HERE/tarball.mjs" registered "$TMP/p.json" "$TMP/packed"
		if [[ -s $TMP/packed ]]; then
			say "the tarball would hold:"
			sed 's/^/  /' "$TMP/packed"
		fi
	fi
	gh_out published "$published"
	if [[ -s $TMP/reasons ]]; then
		gh_out publish false
		say "refused to publish $ver:"
		sed 's/^/  /' "$TMP/reasons"
		return 4
	fi
	if [[ $published == true ]]; then
		gh_out publish false
		say "npm has $PKG@$ver: nothing to publish"
	else
		gh_out publish true
		say "$PKG@$ver is to be published from $sha"
	fi
}

# --- archive -----------------------------------------------------------------------------------------------------
# fetch_artifact NAME ID DIGEST: this run's artifact NAME, by the id and digest the job that made it output,
# unzipped into $TMP/a. Dies unless the API says it is NAME of this run with that digest, and the download has it.
fetch_artifact() {
	local name=$1 id=$2 digest=$3 run=${GITHUB_RUN_ID:?} got
	[[ $id =~ ^[0-9]{1,20}$ && $digest =~ ^(sha256:)?[0-9a-f]{64}$ ]] || die "$name: not an artifact id and digest"
	digest="sha256:${digest#sha256:}"
	gh api "repos/$REPO/actions/artifacts/$id" |
		jq -e --arg run "$run" --arg n "$name" --arg d "$digest" '(.workflow_run.id | tostring) == $run and .name == $n and (.expired | not) and .digest == $d' >/dev/null ||
		die "artifact $id is not $name of run $run with $digest"
	gh api "repos/$REPO/actions/artifacts/$id/zip" >"$TMP/a.zip" || die "cannot download artifact $id"
	got=$( (sha256sum "$TMP/a.zip" 2>/dev/null || shasum -a 256 "$TMP/a.zip") | cut -d' ' -f1)
	[[ "sha256:$got" == "$digest" ]] || die "artifact $id downloads as sha256:$got, not $digest"
	rm -rf "${TMP:?}/a"
	mkdir -p "$TMP/a"
	unzip -q -o "$TMP/a.zip" -d "$TMP/a"
}

# archive ID DIGEST INTEGRITY SHA VERSION DEST: the archive the test job packed, loaded and checked. One file,
# pi-cache-keeper-VERSION.tgz, whose sha512 is INTEGRITY (recorded before any dependency code ran), shipping exactly
# the files npm packs from SHA, each with SHA's bytes. Copied to DEST; its path, alone, on standard output.
cmd_archive() {
	local id=${1:-} digest=${2:-} integ=${3:-} sha=${4:-} v=${5:-} dest=${6:-} rc=0 f files
	[[ $# -eq 6 ]] || die "archive: ID DIGEST INTEGRITY SHA VERSION DEST"
	[[ ${GITHUB_REF:-refs/heads/main} == refs/heads/main ]] || die "archive runs on refs/heads/main only"
	[[ $integ =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || die "archive: INTEGRITY is not a sha512 integrity"
	[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "archive: SHA is not a commit id"
	is_plain "$v" || die "archive: VERSION $(shown "$v") is not a plain version"
	[[ -n $dest && ! -e $dest/$PKG-$v.tgz ]] || die "archive: DEST is empty or already has the archive"
	git cat-file -e "$sha^{commit}" 2>/dev/null || die "archive: $sha is not in this repository"
	fetch_artifact publish-archive "$id" "$digest"
	files=$(cd "$TMP/a" && find . -mindepth 1 | sed 's#^\./##' | LC_ALL=C sort)
	if [[ $files != "$PKG-$v.tgz" ]] || [[ -L $TMP/a/$PKG-$v.tgz || ! -f $TMP/a/$PKG-$v.tgz ]]; then
		say "refused: the artifact holds $(shown "$(tr '\n' ' ' <<<"$files")"), not the one file $PKG-$v.tgz" >&2
		return 4
	fi
	f=$TMP/a/$PKG-$v.tgz
	if ! node "$HERE/tarball.mjs" verify "$f" "$integ" >&2; then
		say "refused: $PKG-$v.tgz is not the archive the test job recorded ($integ)" >&2
		return 4
	fi
	ships_of "$sha" >&2 || rc=$?
	if ((rc == 0)); then node "$HERE/tarball.mjs" compare "$f" "$sha" "$TMP/ships" >&2 || rc=$?; fi
	if ((rc == 4)); then
		say "refused: $PKG-$v.tgz does not ship exactly the files npm packs from $sha, with its bytes" >&2
		return 4
	elif ((rc != 0)); then
		die "archive: the comparison with $sha failed"
	fi
	mkdir -p "$dest"
	cp "$f" "$dest/$PKG-$v.tgz"
	printf '%s\n' "$dest/$PKG-$v.tgz"
}

# --- tag ---------------------------------------------------------------------------------------------------------
# The commit a tag names, an annotated tag followed to its commit; nothing when there is no such tag.
tag_commit() {
	local t=$1 obj type sha
	obj=$(gh api "repos/$REPO/git/ref/tags/$t" 2>/dev/null) || return 0
	type=$(jq -r '.object.type // ""' <<<"$obj")
	sha=$(jq -r '.object.sha // ""' <<<"$obj")
	for _ in 1 2 3 4; do
		[[ $type == tag ]] || break
		obj=$(gh api "repos/$REPO/git/tags/$sha") || die "cannot read the tag object of $t"
		type=$(jq -r '.object.type // ""' <<<"$obj")
		sha=$(jq -r '.object.sha // ""' <<<"$obj")
	done
	[[ $type == commit && $sha =~ ^[0-9a-f]{40}$ ]] || die "$t does not name a commit"
	echo "$sha"
}

# is_release_of COMMIT VERSION: COMMIT is in the live main and its package.json names VERSION.
is_release_of() {
	[[ $1 =~ ^[0-9a-f]{40}$ ]] && git merge-base --is-ancestor "$1" refs/publish/live 2>/dev/null && [[ $(version_of "$1") == "$2" ]]
}

# tag VERSION SHA PUBLISHED: v<VERSION> at the commit published from main, then its GitHub release with the
# changelog's entry. When npm already had the version (PUBLISHED true, a repair): the commit npm recorded, else the
# existing tag, each only when it is in the live main and names the version. Tags are never moved.
cmd_tag() {
	local v=$1 sha=$2 published=$3 t commit have dry=${DRY_RUN:-yes}
	[[ ${GITHUB_REF:-refs/heads/main} == refs/heads/main ]] || die "tag runs on refs/heads/main only"
	is_plain "$v" || die "tag: not a plain version"
	[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "tag: not a commit id"
	t="v$v"
	git fetch -q --no-tags "$UPSTREAM_URL" "+refs/heads/main:refs/publish/live" || die "cannot fetch the live main"
	commit=$sha
	if [[ $published == true ]]; then
		commit=$(npm_githead "$v")
		if ! is_release_of "$commit" "$v"; then
			have=$(tag_commit "$t")
			if is_release_of "$have" "$v"; then
				commit=$have
			else
				die "npm has $v but no commit of main that names $v, and no $t at one: make the tag by hand (docs/publishing.md)"
			fi
		fi
	fi
	git merge-base --is-ancestor "$commit" refs/publish/live || die "$commit is not in the live main"
	[[ $(version_of "$commit") == "$v" ]] || die "$commit's package.json does not name $v: it is not tagged $t"
	have=$(tag_commit "$t")
	if [[ -n $have ]]; then
		[[ $have == "$commit" ]] || die "$t names $have, not $commit: tags are never moved"
	elif [[ $dry != no ]]; then
		say "dry run: would tag $t at $commit"
	else
		gh api -X POST "repos/$REPO/git/refs" -f ref="refs/tags/$t" -f sha="$commit" >/dev/null || die "cannot make $t"
		say "tagged $t at $commit"
	fi
	if gh release view "$t" -R "$REPO" >/dev/null 2>&1; then
		say "the release $t exists"
		return 0
	fi
	git show "$commit:CHANGELOG.md" >"$TMP/changelog" 2>/dev/null || : >"$TMP/changelog"
	awk -v h="## [$v]" 'index($0, h) == 1 { on = 1; next } /^## / { on = 0 } on' "$TMP/changelog" >"$TMP/notes.md"
	[[ -s $TMP/notes.md ]] || echo "$PKG $v." >"$TMP/notes.md"
	if [[ $dry != no ]]; then
		say "dry run: would create the release $t, with these notes ($(wc -l <"$TMP/notes.md" | tr -d ' ') lines):"
		head -n 20 "$TMP/notes.md" | cut -c1-200 | sed 's/^/  /'
		return 0
	fi
	gh release create "$t" -R "$REPO" --verify-tag --title "$PKG $v" --notes-file "$TMP/notes.md" >/dev/null ||
		die "cannot create the release $t"
	say "released $t"
}

# --- report-publish ----------------------------------------------------------------------------------------------
# The bot's issues carry the label $LABEL, are opened by the bot, and begin with a hidden key: the body's first line
# is exactly the key marker, its second the state marker. Nothing else is ever edited.
key_marker() { printf '<!-- publish-bot:key=%s -->' "$1"; }
state_marker() { printf '<!-- publish-state: %s -->' "$1"; }
JQ_KEY='def line($i): ((.body // "") | split("\n") | .[$i] // "" | rtrimstr("\r")); def keyline: line(0); def stateline: line(1);'

# All the bot's issues with the label, every page: [{number, title, body, state}].
bot_issues() {
	gh api --paginate "repos/$REPO/issues?state=all&labels=$LABEL&per_page=100" >"$TMP/issues.raw" || return 1
	jq -s --arg bots " $BOT_LOGINS " --arg label "$LABEL" '[.[] | if type == "array" then .[] else . end
		| (.user.login // "?") as $u
		| select((has("pull_request") | not) and ($bots | contains(" " + $u + " ")) and any(.labels[]?; .name == $label))
		| {number, title, body: (.body // ""), state}]' "$TMP/issues.raw"
}

ensure_label() {
	gh api "repos/$REPO/labels/$LABEL" >/dev/null 2>&1 && return 0
	gh api -X POST "repos/$REPO/labels" -f name="$LABEL" -f color=5319e7 \
		-f description="Opened and updated by the publish workflow" >/dev/null 2>&1 || true
}

# upsert KEY TITLE STATE BODYFILE: the bot's issue with KEY gets TITLE and the body (reopened if closed); a comment
# only when its state changes. None: a new one. Exit 1 when a write fails.
upsert() {
	local key=$1 title=$2 state=$3 body=$4 found num old ost
	{
		key_marker "$key"
		echo
		state_marker "$state"
		echo
		echo
		head -c 60000 "$body"
	} >"$TMP/upsert.md"
	bot_issues >"$TMP/bot.json" || {
		say "cannot list the issues"
		return 1
	}
	found=$(jq -c --arg m "$(key_marker "$key")" "$JQ_KEY"' [.[] | select(keyline == $m)] | sort_by(if .state == "open" then 0 else 1 end, .number) | first // empty' "$TMP/bot.json")
	if [[ -z $found ]]; then
		ensure_label
		gh issue create -R "$REPO" --title "$title" --label "$LABEL" --body-file "$TMP/upsert.md" >/dev/null || return 1
		say "issue opened: $title"
		return 0
	fi
	num=$(jq -r .number <<<"$found")
	ost=$(jq -r .state <<<"$found")
	old=$(jq -r "$JQ_KEY"' (stateline | capture("^<!-- publish-state: (?<s>[^>]*) -->$") | .s) // ""' <<<"$found")
	if [[ $ost != open ]]; then gh issue reopen "$num" -R "$REPO" >/dev/null || return 1; fi
	gh issue edit "$num" -R "$REPO" --title "$title" --body-file "$TMP/upsert.md" >/dev/null || return 1
	if [[ $old != "$state" || $ost != open ]]; then
		gh issue comment "$num" -R "$REPO" --body "Now: **$state**${RUN_URL:+ ($RUN_URL)}" >/dev/null || return 1
		say "issue #$num: now $state"
	else
		say "issue #$num: still $state"
	fi
}

# report-publish VERSION RESULT: success, outside a dry run and with the version on npm, closes the bot's publish
# issue of VERSION; anything else opens or updates it. A dry run closes nothing. After a success, npm is given up
# to NPM_SHOW_WAIT seconds to show the version before the publish counts as failed.
cmd_report_publish() {
	local v=$1 result=$2 key n dry=${DRY_RUN:-yes}
	if ! is_plain "$v"; then
		v=unknown
		[[ $result != success ]] || result="the jobs succeeded, but main's version is not plain"
	fi
	key="publish:$v"
	if [[ $result == success ]]; then
		if [[ $dry != no ]]; then
			say "dry run: no issue is closed"
			return 0
		fi
		if npm_wait_for "$v"; then
			bot_issues >"$TMP/bot.json" || return 1
			for n in $(jq -r --arg m "$(key_marker "$key")" "$JQ_KEY"' .[] | select(.state == "open" and keyline == $m) | .number' "$TMP/bot.json"); do
				gh issue close "$n" -R "$REPO" --comment "npm has $PKG $v now${RUN_URL:+ ($RUN_URL)}." >/dev/null || return 1
				say "issue #$n closed"
			done
			return 0
		fi
		result="the jobs succeeded, but npm does not show $v after $NPM_SHOW_WAIT s"
	fi
	{
		echo "main names $PKG \`$v\`; publishing it did not complete${RUN_URL:+: $RUN_URL}. Git installs already have it."
		echo
		echo "Jobs: $(printf '%s' "$result" | LC_ALL=C tr -cd 'A-Za-z0-9 ,.:_-' | cut -c1-300)"
		echo
		echo "After the cause is fixed: \`gh workflow run publish.yml -R $REPO -f dry_run=no\` (docs/publishing.md)."
	} >"$TMP/pub.md"
	upsert "$key" "publish: $v — failed" failed "$TMP/pub.md" || say "the issue could not be written"
	return 1
}

# --- main --------------------------------------------------------------------------------------------------------
cmd=${1:-}
[[ $# -eq 0 ]] || shift
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
case $cmd in
'') usage && exit 2 ;;
help | -h | --help) usage && exit 0 ;;
esac
need_npm
case $cmd in
plan) cmd_plan ;;
archive) cmd_archive "$@" ;;
tag) cmd_tag "$@" ;;
report-publish) cmd_report_publish "$@" ;;
*)
	usage
	exit 2
	;;
esac
