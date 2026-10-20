// Tracked source: lmtools/tools/code/pi/lmtools-code.ts. Deploy deliberately to
// ~/.pi/agent/extensions/lmtools-code.ts; deployment does not reload running Pi.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { connect } from "node:net";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type Scope = {
	area: string;
	commonDir: string;
	currentRepoRoot: string;
	mainWorktree: string;
	repoName: string;
	mainSha: string;
};

type BuildJob = {
	schemaVersion: 1;
	key: string;
	area: string;
	commonDir: string;
	currentRepoRoot: string;
	mainWorktree: string;
	mainSha: string;
	repoName: string;
	model: string;
	indexPath: string;
	tmpIndexPath: string;
	logPath: string;
	scriptPath: string;
	pid: number;
	startedAt: string;
	lmtoolsBin: string;
	command: string[];
};

type JobState =
	| { state: "none" }
	| { state: "running"; job: BuildJob }
	| { state: "succeeded"; job: BuildJob; exitCode: number; finishedAt?: string }
	| { state: "failed"; job: BuildJob; exitCode?: number; finishedAt?: string; stale?: boolean };

type EnsureIndexResult =
	| { state: "ready"; indexPath: string; scope: Scope }
	| { state: "started" | "building"; scope: Scope; job: BuildJob; message: string };

type CodeReadToolKind = "search" | "history" | "map";

type CodeReadToolOptions = {
	kind: CodeReadToolKind;
	structured: boolean;
};

type CodeLocation = {
	uri: string;
	path: string;
	start_line: number;
	end_line: number;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
		line_base: 1;
		character_base: 0;
	};
};

type CodeScore = {
	kind: "rerank" | "hybrid" | "distance" | "group" | "none";
	value?: number;
	direction: "higher_is_better" | "lower_is_better" | "none";
	distance?: number;
	hybrid?: number;
};

type RawCodeHit = {
	tier?: string;
	cluster_id?: number;
	sha?: string;
	file_path?: string;
	line_start?: number;
	line_end?: number;
	symbol?: string;
	surviving_text?: string;
	distance?: number;
	rerank_score?: number;
	hybrid_score?: number;
	path_score?: number;
	symbol_score?: number;
	text_score?: number;
	lexical_only?: boolean;
	pr_title?: string;
	pr_number?: number;
	pr_description?: string;
	committed_at?: number;
	merged_by_sha?: string;
};

type RawSearchResult = {
	mode?: string;
	seed?: RawCodeHit;
	hits?: RawCodeHit[];
	groups?: Array<{ file_path?: string; score?: number; hits?: RawCodeHit[] }>;
	reranked?: boolean;
};

type RawHistoryResult = {
	mode?: string;
	anchor_range?: { File?: string; file?: string; startLine?: number; endLine?: number; StartLine?: number; EndLine?: number; start_line?: number; end_line?: number };
	anchor_symbol?: { File?: string; file?: string; Sym?: string; sym?: string };
	topic?: string;
	reranked?: boolean;
	hits?: Array<{
		sha?: string;
		pr_number?: number;
		pr_title?: string;
		pr_description?: string;
		subject?: string;
		committed_at?: number;
		merged_by_sha?: string;
		hunks?: Array<{
			intro_sha?: string;
			file_path?: string;
			symbol?: string;
			hunk_seq?: number;
			old_start?: number;
			old_lines?: number;
			new_start?: number;
			new_lines?: number;
			hunk_text?: string;
		}>;
		distance?: number;
		rerank_score?: number;
	}>;
};

type RawMapResult = {
	mode?: string;
	seed?: {
		cluster_id?: number;
		hunk_id?: number;
		file_path?: string;
		line_start?: number;
		line_end?: number;
		symbol?: string;
		identifier?: string;
		surviving_text?: string;
		path_class?: string;
	};
	buckets?: Array<{
		name?: string;
		suppressed?: boolean;
		hits?: Array<{
			cluster_id?: number;
			file_path?: string;
			line_start?: number;
			line_end?: number;
			symbol?: string;
			surviving_text?: string;
			path_class?: string;
			bucket?: string;
			source?: string;
			co_change_count?: number;
			linking_sha?: string;
			linking_pr_title?: string;
		}>;
	}>;
	reranked?: boolean;
	contributing_commits_considered?: number;
	contributing_commits_kept?: number;
	notes?: string[];
};

const EXTENSION_NAME = "lmtools-code";
const DEFAULT_QUERY_TIMEOUT_MS = 120_000;
const DEFAULT_STATUS_TIMEOUT_MS = 20_000;
const DEFAULT_UPDATE_TIMEOUT_MS = 60_000;
const MAIN_REF = "refs/heads/main";
const LMTOOLS_REPO = "/Users/olivier/src/github.com/Shopify-playground/lmtools";

// The lmtools binary is not on PATH and must be invoked through the
// dev wrapper. This matches how the subconscious extension spawns
// children and how `dev lmtools` works in dev.yml.
const DEV_BIN = "/opt/dev/bin/dev";
const DEV_LMTOOLS_ARGS = ["lmtools"];
// lmserve's socket (paths.socket_path on macOS); polled for queue_depth
// while a search/history/map child runs.
const LMSERVE_SOCKET = process.env.LMSERVE_SOCKET || join(homedir(), "Library", "Application Support", "lmtools", "lmserve.sock");
const GPU_QUEUE_POLL_MS = 250;
const MAX_RETURN_LINES = DEFAULT_MAX_LINES;
const MAX_RETURN_BYTES = DEFAULT_MAX_BYTES;
const DEFAULT_INITIAL_K = 3;
const DEFAULT_CHUNKS_PER_FILE = 2;
const CODE_OUTPUT_SCHEMA_VERSION = "lmtools.code.*.v1";
const INTEREST_CONFIG_PATH = join(homedir(), ".lmtools", "code", "interests.toml");
const INTEREST_SELECTION_PATH = join(homedir(), ".lmtools", "config.toml");
const INTEREST_GENERATE_BIN = join(LMTOOLS_REPO, "target", "debug", "lmtools");
const INTEREST_BUILD_HINT = "Interest build state requires the interest-shards build of lmtools (ow/interest-shards, once reconciled to main).";

type InterestDefinition = {
	repo: string; repository: string; area: string; seeds: string[];
	source?: "personal" | "area-catalogue";
	classes?: string[];
};
type InterestCatalogue = { path: string; exists: boolean; interests: Record<string, { seeds: string[]; classes?: string[] }> };
type InterestRegistry = Record<string, InterestDefinition>;
type InterestStatusRow = { name: string; state: string; active: boolean; [key: string]: unknown };

const interestNameParam = Type.String({
	description: "Unique interest name, lowercase letters/digits plus dot, underscore or hyphen (1-64 characters).",
	pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
});
const interestAddParams = Type.Object({
	name: interestNameParam,
	paths: Type.Optional(Type.Array(Type.String(), {
		minItems: 1,
		description: 'Existing World folders in one top-level area. Absolute, "~" and Pi-cwd-relative paths accepted. Choose exactly one of paths, seedSpec or catalogue.',
	})),
	catalogue: Type.Optional(Type.Object({
		repo: Type.String({ description: "Local World checkout path, absolute or relative to Pi cwd." }),
		area: Type.String({ description: "World area whose committed lmtools-interests.toml catalogue contains name." }),
		repository: Type.Optional(Type.String({ description: 'Canonical repository id, default "world".' })),
	}, { description: "Choose name from an area's catalogue instead of defining personal paths/seeds. Saves a snapshot/reference only, does not activate it. Mutually exclusive with paths and seedSpec." })),
	seedSpec: Type.Optional(Type.Object({
		repo: Type.String({ description: "Local World checkout path, absolute or relative to Pi cwd." }),
		repository: Type.Optional(Type.String({ description: 'Canonical repository id used by the interest CLI, default "world" (not the worktree directory name).' })),
		area: Type.String({ description: 'Top-level area, e.g. "areas/clients/admin-web".' }),
		seeds: Type.Array(Type.String(), { minItems: 1, description: "Area-relative file/folder prefixes, not glob patterns." }),
	})),
});

const AreaParam = Type.Optional(
	Type.String({
		description:
			"World monorepo area to query, e.g. areas/clients/admin-mobile. If omitted, inferred from cwd. Nested paths are collapsed to their top-level area.",
	}),
);
const CwdParam = Type.String({
	description:
		'Required. Directory to run from / infer the World area from. Accepts an absolute path, a path relative to the current Pi cwd, a "~"-prefixed path, or "." for the directory Pi is currently running in.',
});

const TopKParam = Type.Optional(
	Type.Integer({
		description: "Maximum results to return. Recommended initial value/default: 3; increase to 5-10 only after the first pass is too sparse. Alias of limit; kept for existing sessions.",
		minimum: 1,
		maximum: 50,
		default: DEFAULT_INITIAL_K,
	}),
);
const LimitParam = Type.Optional(
	Type.Integer({
		description: "Maximum results to return. Preferred common API name; equivalent to topK.",
		minimum: 1,
		maximum: 50,
	}),
);
const OutputParam = Type.Optional(
	Type.String({
		description:
			"Output format: json (default stable Sourcegraph/LSP-style envelope) or text (legacy lmtools CLI rendering).",
		default: "json",
	}),
);
const FullParam = Type.Optional(
	Type.Boolean({ description: "Disable lmtools' render-time body cap. Use sparingly; Pi will still truncate large tool output." }),
);
const NoRerankParam = Type.Optional(Type.Boolean({ description: "Skip cross-encoder reranking even if lmserve has one configured." }));

const searchParams = Type.Object({
	area: AreaParam,
	cwd: CwdParam,
	query: Type.Optional(Type.String({ description: "Natural-language code search query. Mutually exclusive with symbol." })),
	symbol: Type.Optional(Type.String({ description: "Seed search from a HEAD-state symbol, e.g. path/to/file.ts::symbol or symbol." })),
	excludeSameFile: Type.Optional(Type.Boolean({ description: "When symbol is set, drop hits from the seed symbol's file." })),
	topK: TopKParam,
	limit: LimitParam,
	output: OutputParam,
	groupByFile: Type.Optional(
		Type.Boolean({
			description:
				"Group query-mode hits by file instead of individual chunks. Recommended/default for broad searches: true; set false only when chunk-level ranking matters.",
			default: true,
		}),
	),
	chunksPerFile: Type.Optional(
		Type.Integer({
			description: "When groupByFile is true, max chunks to show per file. Recommended initial value/default: 2.",
			minimum: 1,
			maximum: 10,
			default: DEFAULT_CHUNKS_PER_FILE,
		}),
	),
	noRerank: NoRerankParam,
	full: FullParam,
});

const historyParams = Type.Object({
	area: AreaParam,
	cwd: CwdParam,
	target: Type.Optional(
		Type.String({
			description:
				"File range or symbol target, e.g. path/file.ts:14-30, path/file.ts::symbol, or symbol. Mutually exclusive with topic.",
		}),
	),
	topic: Type.Optional(Type.String({ description: "Topic-mode query against canonical PR prose. Mutually exclusive with target." })),
	symbol: Type.Optional(Type.Boolean({ description: "Force symbol mode for an ambiguous target." })),
	since: Type.Optional(Type.String({ description: "Topic mode lower date bound, YYYY-MM-DD inclusive." })),
	until: Type.Optional(Type.String({ description: "Topic mode upper date bound, YYYY-MM-DD exclusive." })),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum canonical PRs to return. Recommended initial value/default: 3; increase only if the first pass needs more history.",
			minimum: 1,
			maximum: 100,
			default: DEFAULT_INITIAL_K,
		}),
	),
	noRerank: NoRerankParam,
	sort: Type.Optional(Type.String({ description: "Topic mode sort: relevance or date." })),
	minRerank: Type.Optional(Type.Number({ description: "Topic mode: drop hits below this rerank score when reranking ran." })),
	output: OutputParam,
	full: FullParam,
});

const mapParams = Type.Object({
	area: AreaParam,
	cwd: CwdParam,
	target: Type.String({ description: "Target to map: path/file.ts:14-30, path/file.ts::symbol, or symbol." }),
	symbol: Type.Optional(Type.Boolean({ description: "Force symbol mode for an ambiguous target." })),
	topK: TopKParam,
	limit: LimitParam,
	output: OutputParam,
	include: Type.Optional(
		Type.Array(Type.String(), {
			description: "Default-suppressed buckets to include: stories, generated, docs, i18n, other.",
		}),
	),
	noRerank: NoRerankParam,
	full: FullParam,
});

const updateParams = Type.Object({
	cwd: CwdParam,
	branch: Type.Optional(Type.String({ minLength: 1, description: "Branch to update. Omit to use the checked-out branch; only committed changes are indexed." })),
});

const statusParams = Type.Object({
	area: AreaParam,
	cwd: CwdParam,
	tailLines: Type.Optional(
		Type.Integer({
			description: "Build log lines to include. Recommended/default: 40 for progress checks; use 0 for metadata only.",
			minimum: 0,
			maximum: 200,
			default: 40,
		}),
	),
});

let cachedLmtoolsBin: string | undefined;
const startingBuilds = new Map<string, Promise<EnsureIndexResult>>();
const scopeCache = new Map<string, Scope>();
const readyIndexCache = new Map<string, { indexPath: string; scope: Scope }>();
// `daemon status` costs ~0.4s per spawn; the loaded embed model rarely changes, so cache it for a few minutes.
const EMBED_MODEL_TTL_MS = 5 * 60_000;
let embedModelCache: { model: string; at: number } | undefined;
const TOOL_NAMES = ["lmtools_code_search", "lmtools_code_history", "lmtools_code_map", "lmtools_code_index_status", "lmtools_code_interest_list", "lmtools_code_interest_generate", "lmtools_code_update"] as const;

const LMTOOLS_CODE_TOOL_GUIDE = `## lmtools code tools — when and how to use them
These tools are only for Shopify World code retrieval. They query main-branch lmtools indexes scoped to top-level monorepo areas such as areas/clients/admin-mobile. They are not for Brain, docs, Slack, or arbitrary repositories.

Output/API: search/history/map return stable flat JSON by default (schemas: "lmtools.code.search.v1", "lmtools.code.history.v1", "lmtools.code.map.v1") with common fields like scope, path, start_line/end_line, target, symbol, snippet/diff, score, and commit/PR provenance. Pass output="text" only when you specifically need the legacy lmtools terminal rendering.

Decision tree:
- Use lmtools_code_search first for broad "where is this implemented?", "find similar code", "what changed in HEAD?", or concept-to-current-code questions. It searches current HEAD-state code, not diffs. Start narrow: query + limit=3 + groupByFile=true + chunksPerFile=2. Increase limit to 5-10 only if useful hits are missing. Use symbol instead of query when you already know a seed symbol and want similar code.
- Use lmtools_code_history when the user asks "why/who/when changed this?" or needs PR/commit candidates. For a known file/range/symbol, pass target and limit=3. For concept history, pass topic and limit=3; since/until only apply with topic.
- Use lmtools_code_map after you have a concrete file range or symbol and need a HEAD-state feature explanation / blast radius: self, same-file internals, likely callers, co-changers, and tests. Start with limit=3. Add include=["docs"|"i18n"|"stories"|"generated"|"other"] only when those suppressed buckets are explicitly relevant.
- Use lmtools_code_interest_list with area set to your current area/subpath to check whether an added interest already intersects your scope before investigating or asking for a new one. Empty lists fail and point to lmtools_code_interest_generate. coversThisArea is definition overlap, not proof of a built/active index; inspect build too. Glob overlap may be unknown.
- Use lmtools_code_interest_generate with cwd set to the folder to partition. It publishes only an absent area-local .lmtools/interests.toml, self-ignored by .lmtools/.gitignore with *, never outer-ignore edits. Existing identical/edited outputs refuse even on a cache hit: explicitly delete the untracked regular snapshot first, no force flag. Cache reuse is computation reuse only; list/apply/measured recuts never restore snapshots. This folder is not the global ~/.lmtools/[tool]/interests.toml registry. Independent cwd/target parent guards require the config root; committed curated targets refuse generation. Inventory/weights/leaves/groups/naming/write progress streams live. CPU-only, no registration, activation, models or index builds.
- Use lmtools_code_update after setting up a branch/worktree and again after committing. It previews then applies the CLI's pinned-to-main branch fast path; it requires a warm cached interest epoch and never falls back to rebuilding main.
- Use lmtools_code_index_status only to check readiness/progress, especially after another lmtools code tool says it started or found a running background build. Do not run bash to build indexes manually.

lmtools vs git examples:
- To understand current HEAD behavior: use lmtools_code_search to find relevant files/symbols, then read the current files directly if exact code is needed.
- To explain a feature in HEAD after finding a target: use lmtools_code_map on the symbol/range to gather related callers, tests, and co-changing anchors; then read specific files for exact implementation details.
- To investigate why something changed: use lmtools_code_history with limit=3 to get likely PR/commit candidates, then use git show <sha> or git show <sha> -- <path> to inspect the full commit diff. lmtools is for candidate discovery; git is for authoritative full patches.
- Prefer lmtools_code_history over git log --all for candidate discovery. In World, git log --all is much slower and less targeted; use it only as a last resort after lmtools_code_history and narrower git log commands fail.
- To verify an exact known commit, branch, or local uncommitted diff: use git directly (git show, git diff, narrow git log). Do not force lmtools when the user already gave an exact SHA or asks for the full diff.

Operational rules:
- If a tool reports a missing index and starts a background build, stop the retrieval flow and tell the user the build is in progress; call lmtools_code_index_status for progress.
- cwd is required on search/history/map/index_status/update/interest_generate calls (interest registry add/remove/list tools do not require it). Pass cwd="." to mean the directory Pi is currently running in; relative paths resolve from the current Pi cwd, absolute and "~" paths are accepted.
- Omit area when the cwd you pass is already inside the target World area. Pass area="areas/<group>/<area>" only when asking about a different area from that cwd.
- Avoid full=true on the first pass; use it only after a compact result identifies a specific hit that needs full bodies.
- Prefer the default JSON output for follow-up tool calls: copy location.path, start_line/end_line, target, commit.sha, or bucketed relation_kind directly instead of parsing prose.`;

export default function lmtoolsCodeExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const activeToolNames = new Set(
			(pi.getActiveTools() as Array<string | { name: string }>).map((tool) => (typeof tool === "string" ? tool : tool.name)),
		);
		if (!TOOL_NAMES.some((name) => activeToolNames.has(name))) {
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${LMTOOLS_CODE_TOOL_GUIDE}` };
	});

	pi.registerTool({
		name: "lmtools_code_search",
		label: "lmtools code search",
		description:
			"Semantic search over HEAD-state code in a Shopify World monorepo area. Use for broad code discovery: where behavior is implemented, similar patterns, likely files/symbols, or concept-to-code lookup. Returns a stable JSON envelope by default with Sourcegraph/LSP-style locations, snippets, scores, and PR provenance; pass output=text for legacy terminal rendering. Initial recommended call: query + limit=3 + groupByFile=true + chunksPerFile=2. Use symbol instead of query only when you already know a seed symbol and want nearby/similar code. If no main-branch area index exists, starts the build in the background and returns progress instructions instead of blocking. cwd is required (use \".\" for the current Pi cwd).",

		promptSnippet:
			"Semantic code search for World areas. Start with limit=3, groupByFile=true, chunksPerFile=2; returns stable JSON by default; auto-starts missing main-branch area indexes.",
		promptGuidelines: [
			"Use lmtools_code_search before broad grep for Shopify World HEAD-state code discovery: where code lives, how current behavior is implemented, or examples of similar behavior.",
			"Use lmtools_code_search for semantic discovery, then use read/grep/git only after it identifies concrete files, symbols, or exact follow-up targets.",
			"For lmtools_code_search broad query mode, start with limit=3, groupByFile=true, chunksPerFile=2; increase limit only after the first pass is too sparse.",
			"lmtools_code_search returns stable JSON by default; use output=text only when legacy terminal rendering is explicitly useful.",
			"For lmtools_code_search symbol mode, pass symbol when you already know a seed symbol; use excludeSameFile=true to find the pattern elsewhere.",
			"lmtools_code_search only indexes top-level World areas such as areas/clients/admin-mobile, and builds missing indexes from main in the background.",
			"If lmtools_code_search reports that a build started or is running, call lmtools_code_index_status to check progress rather than retrying the same search.",
		],
		parameters: searchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			validateSearchParams(params);
			validateOutputParam(params.output);
			const cwd = toolCwd(ctx, params.cwd);
			onUpdate?.({ content: [{ type: "text", text: "Resolving lmtools code index..." }], details: undefined });
			const ensured = await ensureIndex(pi, cwd, params.area, signal);
			if (ensured.state !== "ready") {
				return buildPendingResult(ensured);
			}

			const structured = wantsStructuredOutput(params.output);
			const limit = params.limit ?? params.topK ?? DEFAULT_INITIAL_K;
			const args = ["code", "search", "--index", ensured.indexPath, "--top-k", String(limit)];
			if (structured) args.push("--json");
			if (params.noRerank) args.push("--no-rerank");
			if (params.full) args.push("--full");
			if (params.symbol) {
				args.push("--symbol", params.symbol);
				if (params.excludeSameFile) args.push("--exclude-same-file");
			} else {
				if (params.groupByFile ?? true) {
					args.push("--group-by", "file", "--chunks-per-file", String(params.chunksPerFile ?? DEFAULT_CHUNKS_PER_FILE));
				}
				args.push(params.query!.trim());
			}
			return withGpuQueueLabel(onUpdate, "Searching lmtools index...", () =>
				runLmtoolsReadTool(pi, args, cwd, signal, ensured.scope, { kind: "search", structured }),
			);
		},
	});

	pi.registerTool({
		name: "lmtools_code_history",
		label: "lmtools code history",
		description:
			"Chronological PR/commit candidate discovery for Shopify World code. Use when the user asks why code exists, who changed a file/range/symbol, when behavior changed, or which PRs introduced a concept. Returns a stable JSON envelope by default with commit/PR objects and LSP-style hunk locations; pass output=text for legacy terminal rendering. Initial recommended call: target + limit=3 for known file ranges/symbols, or topic + limit=3 for concept history. Prefer this over git log --all: in World, git log --all is much slower and should be the last option for candidate discovery. Then use git show <sha> or git show <sha> -- <path> for authoritative full commit diffs. since/until only apply to topic mode. Missing area indexes are built from main in the background. cwd is required (use \".\" for the current Pi cwd).",

		promptSnippet:
			"PR/commit candidate discovery for World code. Start with limit=3; use git show on returned SHAs for full diffs.",
		promptGuidelines: [
			"Use lmtools_code_history when the user asks who changed code, why code changed, when behavior changed, or what PR introduced behavior in Shopify World.",
			"Use lmtools_code_history to produce candidate commits/PRs, then use git show <sha> or git show <sha> -- <path> when the user needs the full diff or exact patch.",
			"Prefer lmtools_code_history over git log --all for candidate discovery; git log --all is much slower in World and should be the last option after lmtools and narrower git log commands fail.",
			"For lmtools_code_history known code, pass target like path/file.ts:14-30, path/file.ts::symbol, or a symbol name, and start with limit=3.",
			"For lmtools_code_history concept provenance, pass topic with limit=3; only use since/until with topic mode.",
			"lmtools_code_history returns stable JSON by default; use output=text only when legacy terminal rendering is explicitly useful.",
			"If the user already provides an exact SHA or asks only for a full commit diff, skip lmtools_code_history and use git show directly.",
			"lmtools_code_history targets main-branch area indexes; when an index is missing it starts a background build and returns progress instructions.",
		],
		parameters: historyParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			validateHistoryParams(params);
			validateOutputParam(params.output);
			const cwd = toolCwd(ctx, params.cwd);
			onUpdate?.({ content: [{ type: "text", text: "Resolving lmtools code index..." }], details: undefined });
			const ensured = await ensureIndex(pi, cwd, params.area, signal);
			if (ensured.state !== "ready") {
				return buildPendingResult(ensured);
			}

			const structured = wantsStructuredOutput(params.output);
			const args = ["code", "history", "--index", ensured.indexPath, "--limit", String(params.limit ?? DEFAULT_INITIAL_K)];
			if (structured) args.push("--json");
			if (params.noRerank) args.push("--no-rerank");
			if (params.full) args.push("--full");
			if (params.symbol) args.push("--symbol");
			if (params.topic) {
				args.push("--topic", params.topic.trim());
				if (params.since) args.push("--since", params.since);
				if (params.until) args.push("--until", params.until);
				if (params.sort) args.push("--sort", params.sort);
				if (params.minRerank !== undefined) args.push("--min-rerank", String(params.minRerank));
			} else {
				args.push(params.target!.trim());
			}
			return withGpuQueueLabel(onUpdate, "Querying lmtools history...", () =>
				runLmtoolsReadTool(pi, args, cwd, signal, ensured.scope, { kind: "history", structured }),
			);
		},
	});

	pi.registerTool({
		name: "lmtools_code_map",
		label: "lmtools code map",
		description:
			"HEAD-state feature explanation and blast-radius map for a concrete Shopify World file range or symbol. Use after search/read identifies a target and you need related current-code anchors: self, same-file internals, likely callers, co-changers, tests, plus optional suppressed buckets. Returns a stable JSON envelope by default with bucketed relations (`relation_kind`) and LSP-style locations; pass output=text for legacy terminal rendering. Initial recommended call: target + limit=3. Add include only for docs/i18n/stories/generated/other when explicitly relevant. Use git only after map if you need historical diffs for a returned commit. Missing area indexes are built from main in the background. cwd is required (use \".\" for the current Pi cwd).",

		promptSnippet:
			"HEAD-state feature explanation/blast-radius map for a World symbol or range. Start with limit=3; returns stable JSON by default; read mapped files for exact code.",
		promptGuidelines: [
			"Use lmtools_code_map after you have a concrete file range or symbol and need a HEAD-state feature explanation, blast-radius, likely callers, tests, or co-changing anchors in Shopify World.",
			"Use lmtools_code_map for current-code relationships; use git show only later if a returned historical commit needs a full diff.",
			"For lmtools_code_map, start with target and limit=3; increase limit only when the first map misses needed neighbors.",
			"lmtools_code_map returns stable JSON by default; use output=text only when legacy terminal rendering is explicitly useful.",
			"For lmtools_code_map, pass include only when suppressed buckets are relevant: docs, i18n, stories, generated, or other.",
			"lmtools_code_map only uses main-branch top-level area indexes; status for background builds is available through lmtools_code_index_status.",
		],
		parameters: mapParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			validateOutputParam(params.output);
			const cwd = toolCwd(ctx, params.cwd);
			onUpdate?.({ content: [{ type: "text", text: "Resolving lmtools code index..." }], details: undefined });
			const ensured = await ensureIndex(pi, cwd, params.area, signal);
			if (ensured.state !== "ready") {
				return buildPendingResult(ensured);
			}

			const structured = wantsStructuredOutput(params.output);
			const limit = params.limit ?? params.topK ?? DEFAULT_INITIAL_K;
			const args = ["code", "map", "--index", ensured.indexPath, "--top-k", String(limit)];
			if (structured) args.push("--json");
			if (params.symbol) args.push("--symbol");
			if (params.noRerank) args.push("--no-rerank");
			if (params.full) args.push("--full");
			if (params.include && params.include.length > 0) args.push("--include", params.include.join(","));
			args.push(params.target.trim());
			return withGpuQueueLabel(onUpdate, "Mapping lmtools code...", () =>
				runLmtoolsReadTool(pi, args, cwd, signal, ensured.scope, { kind: "map", structured }),
			);
		},
	});

	pi.registerTool({
		name: "lmtools_code_index_status",
		label: "lmtools code index status",
		description:
			"Read-only status for a Shopify World area code index. Use after search/history/map reports a missing index, started background build, or running build; also useful before promising lmtools results. Initial recommended call: same area as the pending query, tailLines=40. This tool does not start builds; search/history/map start builds automatically. cwd is required (use \".\" for the current Pi cwd).",
		promptSnippet: "Check lmtools World-area index readiness/build progress. Use after build-start messages; tailLines=40 is the default.",
		promptGuidelines: [
			"Use lmtools_code_index_status after lmtools_code_search, lmtools_code_history, or lmtools_code_map reports that an index build started or is already running.",
			"Use lmtools_code_index_status with the same area as the pending query when checking progress from outside that area; tailLines=40 is the recommended default.",
			"lmtools_code_index_status is read-only and does not start a build; do not use bash to manually build lmtools indexes from Pi.",
		],
		parameters: statusParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = toolCwd(ctx, params.cwd);
			const scope = await resolveScope(pi, cwd, params.area, signal);
			const text = await formatIndexStatus(pi, scope, params.tailLines ?? 40, signal);
			return {
				content: [{ type: "text", text }],
				details: { area: scope.area, mainWorktree: scope.mainWorktree, mainSha: scope.mainSha },
			};
		},
	});

	pi.registerTool({
		name: "lmtools_code_update",
		label: "lmtools code update",
		description: "Update the index for the current branch (pin to main, fast-path), call after setting up a branch/worktree and again after committing. Wraps code index update --branch --fast: previews then applies that exact CLI plan, returning commits applied, seconds, and embedded/reused units. cwd is required and must be inside a World area; branch is optional. Requires a warm cached interest epoch and compatible resident daemon; never starts a daemon, updates main, builds a missing area index, or falls back to the slow path. Only committed changes are indexed; full map/review layers may remain deferred. CLI calls are capped at 60 seconds.",
		promptSnippet: "Update a branch's pinned interest index via the CLI fast path after worktree setup and after committing.",
		parameters: updateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.cwd?.trim()) throw new Error("lmtools_code_update requires cwd (use '.' for Pi cwd).");
			if (params.branch !== undefined && (!params.branch.trim() || params.branch !== params.branch.trim() || /[\u0000-\u001f\u007f]/.test(params.branch))) {
				throw new Error("Invalid branch name.");
			}
			const cwd = toolCwd(ctx, params.cwd);
			const repo = await interestRepoRoot(pi, cwd, signal);
			const area = inferArea(repo, cwd, undefined);
			const bin = await resolveLmtoolsBin(pi, signal);
			const args = [...DEV_LMTOOLS_ARGS, "code", "index", "update", "--repo", repo,
				"--index-repo", "world", "--index-path-filter", area,
				params.branch === undefined ? "--branch" : `--branch=${params.branch}`, "--fast", "--json"];
			onUpdate?.({ content: [{ type: "text", text: "Previewing pinned branch index update..." }], details: undefined });
			const preview = await runFastIndexUpdate(pi, bin, args, signal);
			if (!preview.plan_id || preview.fast.vectors !== "planned") throw new Error("Branch update preview did not return a CLI plan; nothing applied.");
			onUpdate?.({ content: [{ type: "text", text: `Updating branch ${preview.fast.branch} from its pinned interest epoch...` }], details: undefined });
			const command = [...args, "--apply-plan", preview.plan_id];
			const result = await runFastIndexUpdate(pi, bin, command, signal);
			if (result.fast.vectors !== "complete") throw new Error("Branch update did not report complete vectors.");
			const work = result.fast.work;
			const summary = {
				commitsApplied: result.fast.phases?.["prepare.commits_written"] ?? (result.changed ? null : 0),
				seconds: (preview.metrics.wall_ms + result.metrics.wall_ms) / 1000,
				units: { embedded: work.primary_jobs + work.window_jobs, reused: work.primary_reused + work.window_reused },
			};
			const output = { summary, ...result };
			return {
				content: [{ type: "text", text: await truncateForTool(JSON.stringify(output, null, 2), "lmtools-code-update") }],
				details: { cwd, command: [bin, ...command], ...output },
			};
		},
	});

	pi.registerTool({
		name: "lmtools_code_interest_add",
		label: "lmtools code interest add",
		description: "Save a named code-tool interest in the user's ~/.lmtools/code/interests.toml registry: choose name from an area catalogue, or define personal folder paths/seedSpec. Interests are per-tool: each tool owns its interests, algorithm, indexes and ~/.lmtools/[tool]/interests.toml registry, so code-tool interests do not collide with other tools' interests. This only saves the user's definition/reference: it does NOT edit area catalogues or ~/.lmtools/config.toml selections, activate an interest, build indexes, or call a model. Selection/activation plumbing is pending SDK support. Existing names are refused; remove first to change one. Python 3.11+ required for TOML parsing.",
		promptSnippet: "Choose an area catalogue code-tool interest or define a personal one (name + catalogue, paths or seedSpec), without building/activating indexes.",
		parameters: interestAddParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			validateInterestName(params.name);
			onUpdate?.({ content: [{ type: "text", text: `Saving interest ${params.name}...` }], details: undefined });
			const definition = await resolveInterestDefinition(pi, params, ctx, signal);
			return withFileMutationQueue(INTEREST_CONFIG_PATH, async () => {
				await runInterestRegistry(pi, "add", { name: params.name, definition }, signal);
				return {
					content: [{ type: "text", text: `Saved interest ${params.name} to ${INTEREST_CONFIG_PATH}.\nGlobal registry only: catalogue and user selections (${INTEREST_SELECTION_PATH}), build and activation are unchanged. Selection plumbing is pending SDK support.` }],
					details: { configPath: INTEREST_CONFIG_PATH, name: params.name, definition, state: "global_only" },
				};
			});
		},
	});

	pi.registerTool({
		name: "lmtools_code_interest_remove",
		label: "lmtools code interest remove",
		description: "Remove a named code-tool interest from the user's ~/.lmtools/code/interests.toml registry only. Registries are per-tool (~/.lmtools/[tool]/interests.toml); this never changes another tool's interests, algorithm or indexes. Does NOT remove or deactivate a per-area configured/built code-tool interest, delete artifacts, or call a model. Python 3.11+ required.",
		promptSnippet: "Remove a personal code-tool interest definition only, leaving per-area config and built indexes untouched.",
		parameters: Type.Object({ name: interestNameParam }),
		async execute(_toolCallId, params, signal, onUpdate) {
			validateInterestName(params.name);
			onUpdate?.({ content: [{ type: "text", text: `Removing interest ${params.name}...` }], details: undefined });
			return withFileMutationQueue(INTEREST_CONFIG_PATH, async () => {
				await runInterestRegistry(pi, "remove", { name: params.name }, signal);
				return {
					content: [{ type: "text", text: `Removed interest ${params.name} from ${INTEREST_CONFIG_PATH}.\nPer-area configuration, build and activation are unchanged.` }],
					details: { configPath: INTEREST_CONFIG_PATH, name: params.name, removed: true },
				};
			});
		},
	});

	pi.registerTool({
		name: "lmtools_code_interest_list",
		label: "lmtools code interest list",
		description: "Check whether your current area is already covered by an added interest before asking for a new one. List code-tool interests from ~/.lmtools/code/interests.toml: personal definitions, area catalogue entries, and CLI activation/build state for areas referenced by this registry. Optional area narrows to the same top-level World area, retaining nested paths for seed-prefix overlap: each registry row gains coversThisArea (true/false, or unknown for unresolved globs). Coverage means definition intersection, not full area coverage or build readiness; inspect build separately. Omit area to list everything. If no registered interests match (including an empty global registry), this tool throws an error directing you to lmtools_code_interest_generate on the target folder. Interests, algorithms, indexes and registries are per-tool (~/.lmtools/[tool]/interests.toml); other tools' interests are not listed. Committed area lmtools-interests.toml files are catalogues. Explicit generation publishes only an absent <area-root>/.lmtools/interests.toml snapshot, self-ignored with a local * rule, never by editing outer ignores. That area folder is not the global ~/.lmtools/[tool]/interests.toml registry. CLI list/apply/measured recuts never publish or restore snapshots; existing identical/edited or tracked outputs refuse explicit generation, requiring deliberate deletion (and explicit untracking if tracked). User selection is separate, not precedence/overrides. Selection parsing/writes are pending the canonical SDK schema and labelled pending. Global-only definitions are NOT automatically configured or built. Read-only, no daemon/model calls or config writes. CLI build state requires the interest-shards build, with clear failures for old binaries. Python 3.11+ required.",
		promptSnippet: "Check scope coverage: optional area returns prefix overlap/unknown plus build state. Empty results error and point to lmtools_code_interest_generate. Never starts builds.",
		parameters: Type.Object({ area: Type.Optional(Type.String({ minLength: 1, description: "World area or nested scope, e.g. areas/clients/admin-web/packages/Sidekick. Repository-relative or absolute World path. Omit to list all interests; no cwd inference." })) }),
		async execute(_toolCallId, params, signal, onUpdate) {
			const requestedArea = params.area === undefined ? undefined : interestCoverageArea(params.area);
			onUpdate?.({ content: [{ type: "text", text: "Reading interests and per-area build state..." }], details: undefined });
			const registry = await runInterestRegistry(pi, "list", {}, signal);
			const interests = Object.fromEntries(Object.entries(registry).filter(([, definition]) =>
				requestedArea === undefined || pathsIntersect(definition.area, requestedArea)));
			const userSelection = {
				path: INTEREST_SELECTION_PATH,
				exists: await fileExists(INTEREST_SELECTION_PATH),
				role: "user-activations-not-a-catalogue-override",
				status: "pending_canonical_sdk_selection_schema",
			};
			if (Object.keys(interests).length === 0) {
				throw new Error(`no interests registered${requestedArea === undefined ? "" : ` for ${requestedArea}`}; run lmtools_code_interest_generate with cwd set to ${requestedArea ?? "the target folder"} to generate the partition. Generation does not add entries to ${INTEREST_CONFIG_PATH}; use lmtools_code_interest_add to register a definition.`);
			}
			const bin = await resolveLmtoolsBin(pi, signal);
			const help = await pi.exec(bin, [...DEV_LMTOOLS_ARGS, "code", "interest", "list", "--help"], {
				cwd: LMTOOLS_REPO, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal,
			});
			if (help.code !== 0) throwInterestCliError(help);
			if (!help.stdout.includes("--index-path-filter") || !/interest list/.test(help.stdout)) {
				throw new Error(INTEREST_BUILD_HINT);
			}
			const byArea = new Map<string, Promise<{ definition: InterestDefinition; catalogue: InterestCatalogue; build: InterestStatusRow[] }>>();
			const rows = await Promise.all(Object.entries(interests).map(async ([name, definition]) => {
				const key = JSON.stringify([definition.repo, definition.repository, definition.area]);
				let pending = byArea.get(key);
				if (!pending) {
					pending = Promise.all([readInterestCatalogue(pi, definition, signal), readInterestBuildState(pi, bin, definition, signal)])
						.then(([catalogue, build]) => ({ definition, catalogue, build }));
					byArea.set(key, pending);
				}
				const area = await pending;
				const catalogueEntry = Object.hasOwn(area.catalogue.interests, name) ? area.catalogue.interests[name] : undefined;
				const build = area.build.find((row) => row.name === name) ?? null;
				return {
					name, ...definition,
					...(requestedArea === undefined ? {} : { coversThisArea: interestCoversArea(definition, requestedArea) }),
					definition_source: definition.source ?? "personal",
					catalogue_source: catalogueEntry ? area.catalogue.path : null,
					catalogue_seeds_match: catalogueEntry ? sameInterestDefinition(definition, catalogueEntry) : null,
					registry_state: catalogueEntry ? "catalogued" : "global_only",
					build,
				};
			}));
			const catalogues = await Promise.all([...byArea.values()].map(async (pending) => {
				const { definition, catalogue, build } = await pending;
				return { repo: definition.repo, repository: definition.repository, area: definition.area,
					source: "area-committed", ...catalogue,
					cli_activations_and_build_state: build };
			}));
			const output = {
				config_path: INTEREST_CONFIG_PATH,
				...(requestedArea === undefined ? {} : { requestedArea, coverage_note: "coversThisArea is saved-definition intersection, not complete scope coverage or build readiness. Same-area non-overlapping entries remain false. Unresolved glob intersections are unknown; dependency closure and class eligibility are not inferred." }),
				user_selection: userSelection,
				note: "Area files are catalogues; user config holds selections (schema/activation tools pending SDK support). Registry add/remove does not activate/deactivate shards. CLI active is observed publication state, not parsed user selections. Catalogue scope is limited to areas referenced by this registry. No builds were performed.",
				catalogues, interests: rows,
			};
			return {
				content: [{ type: "text", text: await truncateForTool(JSON.stringify(output, null, 2), "lmtools-interests") }],
				details: output,
			};
		},
	});

	pi.registerTool({
		name: "lmtools_code_interest_generate",
		label: "lmtools code interest generate",
		description: "Generate a CPU-only TCB partition and publish an absent <area-root>/.lmtools/interests.toml snapshot via the code interest generate CLI (preview mode). cwd is required; optional area selects a repo-relative or absolute World folder, preserving nested paths. Independent strict-ancestor guards for cwd and target include their checkout root: parent lmtools-interests.toml (including committed but worktree-deleted), .lmtools/interests.toml or legacy <folder>.local.toml configs require running from that folder. No descendant scan; child then parent is allowed. Nested repositories/gitlinks and unsafe filesystem paths refuse; linked worktrees work. Target committed curated catalogue errors because generation is a no-op. Existing snapshots ALWAYS refuse, identical or edited, even on a cache hit: deliberately delete the untracked regular snapshot before regeneration. No generation force flag; tracked snapshot/local ignore require explicit untracking. The area's .lmtools/.gitignore self-ignores with *, without outer-ignore edits; this is NOT the global ~/.lmtools/[tool]/interests.toml registry. Cache reuse is computation reuse only. List/apply/measured recuts never create, replace or restore snapshots. Streams inventory → weights → leaves → groups → naming → write events and timings live, including skipped/failure events. Does not apply metadata, register, select, activate, build indexes, load models or call daemon/hosted services. CLI capped at 60 seconds.",
		promptSnippet: "Publish only an absent area .lmtools/interests.toml; delete explicitly before regeneration, no force. Parent configs require their root; curated targets error. Live stage progress, CPU-only, no activation/builds.",
		parameters: Type.Object({
			cwd: CwdParam,
			area: Type.Optional(Type.String({ minLength: 1, description: "Generation folder, repo-relative or absolute World path. Nested scope is preserved, not collapsed to the top-level area. Omit to generate from cwd." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.cwd?.trim()) throw new Error("lmtools_code_interest_generate requires cwd (use '.' for Pi cwd).");
			const cwd = await realpath(toolCwd(ctx, params.cwd));
			if (!(await stat(cwd)).isDirectory()) throw new Error(`Generation folder is not a directory: ${cwd}`);
			const repo = await realpath(await interestRepoRoot(pi, cwd, signal));
			await guardParentInterestConfig(pi, repo, cwd, signal);
			const areaInput = params.area === undefined ? relative(repo, cwd).split(sep).join("/") : normaliseRepoRelative(expandHome(params.area.trim()), repo);
			const folder = await realpath(join(repo, interestCoverageArea(areaInput)));
			const area = interestCoverageArea(relative(repo, folder).split(sep).join("/"));
			if (!(await stat(folder)).isDirectory()) throw new Error(`Generation folder is not a directory: ${folder}`);
			if (await realpath(await interestRepoRoot(pi, folder, signal)) !== repo) throw new Error(`Generation crosses a nested checkout boundary: ${folder}`);
			if (folder !== cwd) await guardParentInterestConfig(pi, repo, folder, signal);
			// HEAD is authoritative, including a committed catalogue deleted only in the worktree.
			const curated = await pi.exec("git", ["--literal-pathspecs", "ls-tree", "HEAD", "--", `${area}/lmtools-interests.toml`], {
				cwd: repo, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal,
			});
			if (curated.code !== 0) throw new Error(`Cannot inspect target catalogue: ${cleanCommandError(curated)}`);
			if (curated.stdout.trim()) throw curatedGenerationError(area);
			if (!(await isExecutable(INTEREST_GENERATE_BIN))) throw new Error(`Interest generation CLI is not executable: ${INTEREST_GENERATE_BIN}`);
			const command = ["code", "interest", "generate", "--repo", repo, "--index-repo", "world", "--index-path-filter", area, "--json"];
			onUpdate?.({ content: [{ type: "text", text: `Checking HEAD-cached interest partition for ${area}...` }], details: undefined });
			const result = await runInterestGeneration(command, signal, onUpdate);
			if (result.code !== 0) throw new Error(`lmtools code interest generate failed: ${cleanCommandError(result)}`);
			let output: InterestGenerateResult;
			try {
				output = JSON.parse(result.stdout);
			} catch {
				throw new Error(`lmtools code interest generate returned invalid JSON: ${cleanCommandError(result)}`);
			}
			if (!output || output.error || output.schema !== "lmtools.code.interest.v1" || output.operation !== "generate"
				|| output.area !== area || typeof output.plan_id !== "string" || !/^[a-f0-9]{64}$/.test(output.plan_id)
				|| typeof output.partition?.meta?.curated !== "boolean") {
				throw new Error(`lmtools code interest generate returned an invalid or failed generation response: ${cleanCommandError(result)}`);
			}
			if (output.partition.meta.curated) throw curatedGenerationError(area);
			return {
				content: [{ type: "text", text: await truncateForTool(combineStdoutStderr(result), "lmtools-interest-generate") }],
				details: { cwd, folder, command: [INTEREST_GENERATE_BIN, ...command], result: output, stderr: result.stderr },
			};
		},
	});
}

type InterestGenerateResult = {
	schema: string;
	operation: string;
	area: string;
	plan_id: string;
	partition: { meta: { curated: boolean } };
	error?: unknown;
};

function curatedGenerationError(area: string): Error {
	return new Error(`${area} is curated (committed lmtools-interests.toml); generation is a no-op. Use the committed catalogue instead.`);
}

async function interestConfigExists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function guardParentInterestConfig(pi: ExtensionAPI, repo: string, cwd: string, signal: AbortSignal | undefined): Promise<void> {
	const rel = relative(repo, cwd);
	if (rel === ".." || rel.startsWith(`..${sep}`) || resolvePath(repo, rel) !== cwd) throw new Error(`Generation folder is outside the checkout: ${cwd}`);
	if (cwd === repo) return;
	// Only exact config paths in ancestors, including the repo root. Never scan HOME or descendants.
	for (let parent = dirname(cwd); ; parent = dirname(parent)) {
		const curatedPath = relative(repo, join(parent, "lmtools-interests.toml")).split(sep).join("/");
		const committed = await pi.exec("git", ["--literal-pathspecs", "ls-tree", "HEAD", "--", curatedPath], {
			cwd: repo, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal,
		});
		if (committed.code !== 0) throw new Error(`Cannot inspect ancestor catalogue: ${cleanCommandError(committed)}`);
		if (committed.stdout.trim() || await interestConfigExists(join(parent, "lmtools-interests.toml"))
			|| await interestConfigExists(join(parent, ".lmtools", "interests.toml")) || await interestConfigExists(join(parent, `${basename(parent)}.local.toml`))) {
			throw new Error(`interest config found in ${parent}; run generation from that folder`);
		}
		if (parent === repo) break;
	}
}

// pi.exec buffers stderr until exit. Forward each complete stage line immediately;
// preserve diagnostics separately and drain an unterminated final line on close.
function runInterestGeneration(args: string[], signal: AbortSignal | undefined, onUpdate: LabelUpdate | undefined): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(INTEREST_GENERATE_BIN, args, {
			cwd: LMTOOLS_REPO, signal, timeout: DEFAULT_UPDATE_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", stderr = "", pending = "";
		const forward = (line: string) => {
			if (/^\[code interest generate\] stage=(inventory|weights|leaves|groups|naming|write) (start|done|skipped|failed)(?:\s|$)/.test(line)) {
				onUpdate?.({ content: [{ type: "text", text: line }], details: undefined });
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			pending += chunk;
			let newline: number;
			while ((newline = pending.indexOf("\n")) >= 0) {
				forward(pending.slice(0, newline).replace(/\r$/, ""));
				pending = pending.slice(newline + 1);
			}
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (pending) forward(pending.replace(/\r$/, ""));
			resolve({ stdout, stderr, code: code ?? -1, killed: child.killed });
		});
	});
}

type FastIndexUpdateResult = {
	schema: string;
	operation: string;
	changed: boolean;
	plan_id?: string;
	fast: {
		branch: string;
		vectors: string;
		phases?: Record<string, number>;
		work: { primary_jobs: number; window_jobs: number; primary_reused: number; window_reused: number };
	};
	metrics: { wall_ms: number };
};

async function runFastIndexUpdate(pi: ExtensionAPI, bin: string, args: string[], signal: AbortSignal | undefined): Promise<FastIndexUpdateResult> {
	const result = await pi.exec(bin, args, { cwd: LMTOOLS_REPO, timeout: DEFAULT_UPDATE_TIMEOUT_MS, signal });
	if (result.code !== 0) throw new Error(`lmtools code index update --branch --fast failed (no slow-path fallback): ${cleanCommandError(result)}`);
	let parsed: FastIndexUpdateResult & { error?: unknown };
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`lmtools code index update returned no valid fast-path JSON. A CLI with code index update --branch --fast --json is required: ${cleanCommandError(result)}`);
	}
	const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (!parsed || parsed.error || parsed.schema !== "lmtools.code.interest.v1" || parsed.operation !== "index update --branch --fast"
		|| typeof parsed.changed !== "boolean" || typeof parsed.fast?.branch !== "string" || !parsed.fast.branch
		|| !["planned", "complete"].includes(parsed.fast.vectors) || !count(parsed.metrics?.wall_ms)
		|| !["primary_jobs", "window_jobs", "primary_reused", "window_reused"].every((key) => count(parsed.fast.work?.[key as keyof typeof parsed.fast.work]))
		|| (parsed.plan_id !== undefined && (typeof parsed.plan_id !== "string" || !/^[a-f0-9]{64}$/.test(parsed.plan_id)))
		|| (parsed.fast.phases !== undefined && (!parsed.fast.phases || typeof parsed.fast.phases !== "object" || Array.isArray(parsed.fast.phases) || !Object.values(parsed.fast.phases).every(count)))) {
		throw new Error(`lmtools code index update returned an invalid or failed fast-path response: ${cleanCommandError(result)}`);
	}
	return parsed;
}

function interestCoverageArea(input: string): string {
	const path = expandHome(input.trim()).replace(/^@/, "").replace(/^\.\//, "").replace(/\/+$/, "");
	const area = path.startsWith("/") ? path.slice(path.indexOf("/areas/") + 1) : path;
	if (!/^areas\/[^/]+\/[^/]+(?:\/.*)?$/.test(area) || /[*?\[\]{}]/.test(area)) {
		throw new Error("area must be a literal World area or nested path: areas/<group>/<area>[/subpath].");
	}
	return validateInterestSeed(area);
}

function pathsIntersect(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function interestCoversArea(definition: InterestDefinition, area: string): boolean | "unknown" {
	let unknown = false;
	for (const seed of definition.seeds) {
		const pattern = `${definition.area}/${validateInterestSeed(seed)}`;
		const glob = pattern.search(/[*?\[\]{}]/);
		if (glob < 0) {
			if (pathsIntersect(pattern, area)) return true;
		} else {
			// A glob's literal directory prefix can rule out overlap, but cannot
			// prove a matching file exists. Never scan World to expand patterns.
			const prefix = pattern.slice(0, pattern.lastIndexOf("/", glob)).replace(/\/+$/, "");
			if (pathsIntersect(prefix, area)) unknown = true;
		}
	}
	return unknown ? "unknown" : false;
}

function sameInterestDefinition(a: { seeds: string[]; classes?: string[] }, b: { seeds: string[]; classes?: string[] }): boolean {
	return JSON.stringify([...new Set(a.seeds.map(validateInterestSeed))].sort()) === JSON.stringify([...new Set(b.seeds.map(validateInterestSeed))].sort())
		&& JSON.stringify(a.classes?.slice().sort()) === JSON.stringify(b.classes?.slice().sort());
}

async function readInterestCatalogue(pi: ExtensionAPI, definition: Pick<InterestDefinition, "repo" | "repository" | "area">, signal: AbortSignal | undefined): Promise<InterestCatalogue> {
	const path = join(definition.repo, definition.area, "lmtools-interests.toml");
	const result = await pi.exec("python3", ["-c", INTEREST_READ_TOML_SCRIPT, path], {
		cwd: LMTOOLS_REPO, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal,
	});
	if (result.code !== 0) throw new Error(`Cannot read interest catalogue ${path}: ${cleanCommandError(result)}`);
	const parsed = JSON.parse(result.stdout) as { exists: boolean; data?: { version?: number; repository?: string; area?: string; interests?: InterestCatalogue["interests"] } };
	if (!parsed.exists) return { path, exists: false, interests: {} };
	const config = parsed.data;
	if (!config || config.version !== 1 || config.repository !== definition.repository || config.area !== definition.area || (config.interests !== undefined && (!config.interests || typeof config.interests !== "object" || Array.isArray(config.interests)))) {
		throw new Error(`Invalid interest catalogue identity/schema in ${path}.`);
	}
	for (const [name, entry] of Object.entries(config.interests ?? {})) {
		validateInterestName(name);
		if (!entry || !Array.isArray(entry.seeds) || !entry.seeds.length || entry.seeds.some((seed) => typeof seed !== "string") || (entry.classes !== undefined && (!Array.isArray(entry.classes) || entry.classes.some((c) => typeof c !== "string")))) throw new Error(`Invalid catalogue definition: ${name}`);
		entry.seeds.forEach(validateInterestSeed);
	}
	return { path, exists: true, interests: config.interests ?? {} };
}

const INTEREST_READ_TOML_SCRIPT = String.raw`
import sys
if sys.version_info < (3, 11):
    sys.exit("Interest catalogues require Python 3.11+ (stdlib tomllib).")
import json, tomllib
try:
    with open(sys.argv[1], "rb") as source:
        print(json.dumps({"exists": True, "data": tomllib.load(source)}))
except FileNotFoundError:
    print(json.dumps({"exists": False}))
except Exception as error:
    sys.exit("Interest catalogue: " + str(error))
`;

function validateInterestName(name: string): void {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("Invalid interest name (expected [a-z0-9][a-z0-9._-]{0,63}).");
}

function validateInterestSeed(seed: string): string {
	const normalized = seed.replace(/\/$/, "");
	if (!normalized || normalized !== normalized.trim() || /[\\\u0000-\u001f\u007f]/.test(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error(`Invalid area-relative interest seed: ${JSON.stringify(seed)}`);
	}
	return normalized;
}

async function interestRepoRoot(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal });
	if (result.code !== 0) throw new Error(`Interest paths must be in a local World checkout: ${cleanCommandError(result)}`);
	const root = result.stdout.trim();
	if (!(await fileExists(join(root, "areas")))) throw new Error(`Interest paths require a World checkout with areas/: ${root}`);
	return root;
}

async function resolveInterestDefinition(
	pi: ExtensionAPI,
	params: { name: string; paths?: string[]; catalogue?: { repo: string; repository?: string; area: string }; seedSpec?: { repo: string; repository?: string; area: string; seeds: string[] } },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<InterestDefinition> {
	if ([params.paths, params.seedSpec, params.catalogue].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one of paths, seedSpec or catalogue.");
	if (params.seedSpec || params.catalogue) {
		const spec = params.seedSpec ?? params.catalogue!;
		const repo = await interestRepoRoot(pi, toolCwd(ctx, spec.repo), signal);
		const area = validateInterestSeed(spec.area);
		if (!/^areas\/[^/]+\/[^/]+$/.test(area) || !(await fileExists(join(repo, area)))) throw new Error(`Not a top-level World area: ${area}`);
		const repository = spec.repository ?? "world";
		if (!repository || repository !== repository.trim() || /[\u0000-\u001f\u007f]/.test(repository)) throw new Error("Invalid canonical repository id.");
		if (params.catalogue) {
			const catalogue = await readInterestCatalogue(pi, { repo, repository, area }, signal);
			const entry = Object.hasOwn(catalogue.interests, params.name) ? catalogue.interests[params.name] : undefined;
			if (!entry) throw new Error(`Interest ${params.name} is not in the area catalogue ${catalogue.path}. Define personal paths/seedSpec instead.`);
			return { repo, repository, area, seeds: [...new Set(entry.seeds.map(validateInterestSeed))].sort(), source: "area-catalogue", ...(entry.classes ? { classes: entry.classes } : {}) };
		}
		if (params.seedSpec!.seeds.length === 0) throw new Error("Interest seeds must not be empty.");
		return { repo, repository, area, seeds: [...new Set(params.seedSpec!.seeds.map(validateInterestSeed))].sort(), source: "personal" };
	}
	if (!params.paths?.length) throw new Error("Interest paths must not be empty.");
	let definition: InterestDefinition | undefined;
	for (const input of params.paths) {
		if (!input.trim()) throw new Error("Interest folder paths must not be empty.");
		const path = await realpath(toolCwd(ctx, input));
		if (!(await stat(path)).isDirectory()) throw new Error(`Interest folder is not a directory: ${path}`);
		const repo = await interestRepoRoot(pi, path, signal);
		const rel = relative(repo, path).split(sep).join("/");
		const parts = rel.split("/");
		if (parts[0] !== "areas" || parts.length < 4) throw new Error(`Select a folder below a top-level World area: ${path}`);
		const area = parts.slice(0, 3).join("/");
		const seed = validateInterestSeed(parts.slice(3).join("/"));
		if (definition && (definition.repo !== repo || definition.area !== area)) throw new Error("One interest must stay within one checkout and top-level World area; use separate names for other areas.");
		definition ??= { repo, repository: "world", area, seeds: [], source: "personal" };
		definition.seeds.push(seed);
	}
	definition!.seeds = [...new Set(definition!.seeds)].sort();
	return definition!;
}

// Python's standard TOML parser avoids a new extension dependency or a partial
// home-grown TOML parser. Canonical rewrites preserve definitions, not comments.
// A process lock + atomic replace complement Pi's in-process mutation queue.
const INTEREST_REGISTRY_SCRIPT = String.raw`
import sys
if sys.version_info < (3, 11):
    sys.exit("Interest registry requires Python 3.11+ (stdlib tomllib).")
import fcntl, json, os, re, tempfile, tomllib

def relative_path(value):
    return (isinstance(value, str) and value and value == value.strip()
            and not re.search(r"[\\\x00-\x1f\x7f]", value)
            and not re.match(r"^[A-Za-z]:", value)
            and all(part not in ("", ".", "..") for part in value.rstrip("/").split("/")))

def main():
    path, action, payload = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    parent = os.path.dirname(path)
    if action == "add":
        os.makedirs(parent, exist_ok=True)
    if not os.path.exists(path) and action != "add":
        if action == "remove":
            raise ValueError("Interest is not in the personal registry: " + payload["name"])
        print("{}")
        return
    lock = None
    try:
        if action != "list":
            lock = open(path + ".lock", "a")
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path, "rb") as source:
                data = tomllib.load(source)
        except FileNotFoundError:
            if action != "add":
                raise
            data = {"version": 1, "interests": {}}
        if set(data) - {"version", "interests"} or type(data.get("version")) is not int or data["version"] != 1:
            raise ValueError("Expected version = 1 and [interests.NAME] tables; refusing to rewrite unknown fields.")
        interests = data.get("interests", {})
        if not isinstance(interests, dict):
            raise ValueError("interests must be named TOML tables")
        for name, definition in interests.items():
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", name):
                raise ValueError("Invalid interest name: " + name)
            if not isinstance(definition, dict) or not {"repo", "repository", "area", "seeds"} <= set(definition) or set(definition) - {"repo", "repository", "area", "seeds", "source", "classes"}:
                raise ValueError("Each interest needs repo, repository, area, seeds and optional source/classes only: " + name)
            if definition.get("source", "personal") not in ("personal", "area-catalogue"):
                raise ValueError("Invalid registry definition source: " + name)
            if "classes" in definition and (not isinstance(definition["classes"], list) or not definition["classes"] or any(not isinstance(c, str) or not c for c in definition["classes"])):
                raise ValueError("Invalid interest classes: " + name)
            if any(not isinstance(definition[k], str) or not definition[k].strip() for k in ("repo", "repository", "area")):
                raise ValueError("Invalid interest scope: " + name)
            if not os.path.isabs(definition["repo"]) or not relative_path(definition["area"]) or not re.fullmatch(r"areas/[^/]+/[^/]+", definition["area"]):
                raise ValueError("Interest repo must be absolute and area must be top-level: " + name)
            seeds = definition["seeds"]
            if not isinstance(seeds, list) or not seeds or any(not relative_path(s) for s in seeds):
                raise ValueError("Interest seeds must be a nonempty string array: " + name)
        if action == "add":
            if payload["name"] in interests:
                raise ValueError("Interest already exists; remove it first: " + payload["name"])
            interests[payload["name"]] = payload["definition"]
        elif action == "remove":
            if payload["name"] not in interests:
                raise ValueError("Interest is not in the personal registry: " + payload["name"])
            del interests[payload["name"]]
        if action != "list":
            quote = lambda s: json.dumps(s, ensure_ascii=False)
            lines = ["# Personal registry, not the user activation config or area catalogue.", "version = 1", ""]
            for name, definition in sorted(interests.items()):
                lines.append("[interests." + quote(name) + "]")
                lines.extend(k + " = " + quote(definition[k]) for k in ("repo", "repository", "area", "seeds", "source", "classes") if k in definition)
                lines.append("")
            temp = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=parent, delete=False) as out:
                    temp = out.name
                    out.write("\n".join(lines))
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp, path)
                temp = None
            finally:
                if temp is not None:
                    os.unlink(temp)
        print(json.dumps(interests))
    finally:
        if lock is not None:
            lock.close()
try:
    main()
except Exception as error:
    sys.exit("Interest registry: " + str(error))
`;

async function runInterestRegistry(
	pi: ExtensionAPI,
	action: "add" | "remove" | "list",
	payload: { name?: string; definition?: InterestDefinition },
	signal: AbortSignal | undefined,
): Promise<InterestRegistry> {
	const result = await pi.exec("python3", ["-c", INTEREST_REGISTRY_SCRIPT, INTEREST_CONFIG_PATH, action, JSON.stringify(payload)], {
		cwd: LMTOOLS_REPO, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal,
	});
	if (result.code !== 0) throw new Error(`Personal interest registry ${action} failed (Python 3.11+ required): ${cleanCommandError(result)}`);
	return JSON.parse(result.stdout) as InterestRegistry;
}

function throwInterestCliError(result: ExecResult): never {
	const output = result.stdout + "\n" + result.stderr;
	if (/unknown command|unrecognized (?:command|subcommand)|unexpected argument|unknown flag/i.test(output)) {
		throw new Error(`${INTEREST_BUILD_HINT}\n${cleanCommandError(result)}`);
	}
	throw new Error(`lmtools code interest list failed: ${cleanCommandError(result)}`);
}

async function readInterestBuildState(pi: ExtensionAPI, bin: string, definition: InterestDefinition, signal: AbortSignal | undefined): Promise<InterestStatusRow[]> {
	const args = [...DEV_LMTOOLS_ARGS, "code", "interest", "list", "--repo", definition.repo, "--index-repo", definition.repository, "--index-path-filter", definition.area, "--json"];
	const result = await pi.exec(bin, args, { cwd: LMTOOLS_REPO, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal });
	if (result.code !== 0) throwInterestCliError(result);
	const parsed = JSON.parse(result.stdout) as { schema?: string; interests?: InterestStatusRow[]; error?: unknown };
	if (parsed.error || parsed.schema !== "lmtools.code.interest.v1" || !Array.isArray(parsed.interests) || parsed.interests.some((row) => !row || typeof row.name !== "string" || typeof row.state !== "string" || typeof row.active !== "boolean")) {
		throw new Error("lmtools code interest list returned an invalid or failed interest-shards response.");
	}
	return parsed.interests;
}

function validateSearchParams(params: { query?: string; symbol?: string }): void {
	const query = params.query?.trim() ?? "";
	const symbol = params.symbol?.trim() ?? "";
	if (!query && !symbol) {
		throw new Error("lmtools_code_search requires either query or symbol");
	}
	if (query && symbol) {
		throw new Error("lmtools_code_search query and symbol are mutually exclusive");
	}
}

function validateHistoryParams(params: { target?: string; topic?: string; since?: string; until?: string }): void {
	const target = params.target?.trim() ?? "";
	const topic = params.topic?.trim() ?? "";
	if (!target && !topic) {
		throw new Error("lmtools_code_history requires either target or topic");
	}
	if (target && topic) {
		throw new Error("lmtools_code_history target and topic are mutually exclusive");
	}
	if (target && (params.since || params.until)) {
		throw new Error("lmtools_code_history since/until apply to topic mode only");
	}
}

function validateOutputParam(output: string | undefined): void {
	if (output === undefined || output === "" || output === "json" || output === "text") return;
	throw new Error(`unsupported output format ${JSON.stringify(output)} (expected "json" or "text")`);
}

function wantsStructuredOutput(output: string | undefined): boolean {
	return output !== "text";
}

// ctx.cwd is a live getter on the session's ExtensionRunner (pi dist/core/extensions/runner.js createContext),
// read per call. A Pi cwd switch replaces the AgentSession + runner and re-imports this module (jiti
// moduleCache: false), so nothing here can hold a stale cwd; module caches are keyed by resolved cwd/scope.
// Empty/whitespace cwd falls back to ctx.cwd defensively even though the schema requires it.
function toolCwd(ctx: ExtensionContext, cwdParam: string | undefined): string {
	if (!cwdParam?.trim()) return ctx.cwd;
	return resolvePath(ctx.cwd, expandHome(cwdParam.trim()));
}

async function ensureIndex(
	pi: ExtensionAPI,
	cwd: string,
	areaParam: string | undefined,
	signal: AbortSignal | undefined,
): Promise<EnsureIndexResult> {
	const scope = await resolveScope(pi, cwd, areaParam, signal);
	const key = jobKey(scope);
	const cached = readyIndexCache.get(key);
	if (cached && cached.scope.mainSha === scope.mainSha && (await fileExists(cached.indexPath))) {
		return { state: "ready", indexPath: cached.indexPath, scope: cached.scope };
	}
	if (cached) readyIndexCache.delete(key);

	const existingStart = startingBuilds.get(key);
	if (existingStart) {
		return existingStart;
	}

	const promise = ensureIndexInner(pi, scope, signal).then((res) => {
		if (res.state === "ready") {
			readyIndexCache.set(key, { indexPath: res.indexPath, scope: res.scope });
		}
		return res;
	}).finally(() => {
		startingBuilds.delete(key);
	});
	startingBuilds.set(key, promise);
	return promise;
}

async function ensureIndexInner(pi: ExtensionAPI, scope: Scope, signal: AbortSignal | undefined): Promise<EnsureIndexResult> {
	const bin = await resolveLmtoolsBin(pi, signal);
	const model = await currentEmbedModel(pi, bin, signal);
	const indexPath = defaultCodeIndexPath(scope.mainWorktree, scope.area, model);
	const state = await readJobState(scope);
	if (state.state === "running") {
		return {
			state: "building",
			scope,
			job: state.job,
			message: `lmtools code index build is already running for ${scope.area} from main (pid ${state.job.pid}).`,
		};
	}
	if (await fileExists(indexPath)) {
		return { state: "ready", indexPath, scope };
	}

	const job = await startBackgroundBuild(bin, scope, model);
	return {
		state: "started",
		scope,
		job,
		message: `No lmtools code index exists for ${scope.area}; started a background build from main (pid ${job.pid}).`,
	};
}

async function resolveScope(
	pi: ExtensionAPI,
	cwd: string,
	areaParam: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Scope> {
	const cacheKey = `${cwd}\u0000${areaParam ?? ""}`;
	const cached = scopeCache.get(cacheKey);
	if (cached) return cached;

	const repoRootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		timeout: DEFAULT_STATUS_TIMEOUT_MS,
		signal,
	});
	if (repoRootResult.code !== 0) {
		throw new Error(`lmtools code tools must run inside a git checkout: ${cleanCommandError(repoRootResult)}`);
	}
	const currentRepoRoot = repoRootResult.stdout.trim();
	if (!(await fileExists(join(currentRepoRoot, "areas")))) {
		throw new Error(
			`lmtools code tools only index Shopify World monorepo areas. ${currentRepoRoot} does not contain a top-level areas/ directory.`,
		);
	}

	const area = inferArea(currentRepoRoot, cwd, areaParam);
	const commonDirResult = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: currentRepoRoot,
		timeout: DEFAULT_STATUS_TIMEOUT_MS,
		signal,
	});
	if (commonDirResult.code !== 0) {
		throw new Error(`failed to resolve git common dir: ${cleanCommandError(commonDirResult)}`);
	}
	const commonDir = commonDirResult.stdout.trim();
	const mainWorktree = await resolveMainWorktree(pi, currentRepoRoot, commonDir, signal);
	if (!(await fileExists(join(mainWorktree, area)))) {
		throw new Error(`World area ${area} does not exist on main at ${mainWorktree}; refusing to index non-main or non-area paths.`);
	}
	const mainShaResult = await pi.exec("git", ["rev-parse", "HEAD"], {
		cwd: mainWorktree,
		timeout: DEFAULT_STATUS_TIMEOUT_MS,
		signal,
	});
	if (mainShaResult.code !== 0) {
		throw new Error(`failed to resolve main HEAD: ${cleanCommandError(mainShaResult)}`);
	}

	const scope = {
		area,
		commonDir,
		currentRepoRoot,
		mainWorktree,
		repoName: basename(mainWorktree),
		mainSha: mainShaResult.stdout.trim(),
	};
	scopeCache.set(cacheKey, scope);
	return scope;
}

function inferArea(repoRoot: string, cwd: string, areaParam: string | undefined): string {
	const raw = areaParam?.trim()
		? normaliseRepoRelative(areaParam.trim(), repoRoot)
		: relative(repoRoot, cwd).split(sep).join("/");
	const parts = raw.split("/").filter(Boolean);
	const areaIndex = parts.indexOf("areas");
	if (areaIndex < 0 || parts.length < areaIndex + 3) {
		throw new Error(
			"lmtools code tools need a World area. Run from inside areas/<group>/<area> or pass area: \"areas/<group>/<area>\".",
		);
	}
	const areaParts = parts.slice(areaIndex, areaIndex + 3);
	if (areaParts.some((part) => part === "." || part === ".." || part.length === 0)) {
		throw new Error(`invalid World area path: ${raw}`);
	}
	return areaParts.join("/");
}

function normaliseRepoRelative(input: string, repoRoot: string): string {
	let value = input.replace(/\\/g, "/").replace(/^@/, "");
	if (value.startsWith("/")) {
		value = relative(repoRoot, value).split(sep).join("/");
	}
	if (value.startsWith("./")) value = value.slice(2);
	return value.replace(/\/+$/, "");
}

async function resolveMainWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	commonDir: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const branchResult = await pi.exec("git", ["branch", "--show-current"], {
		cwd: repoRoot,
		timeout: DEFAULT_STATUS_TIMEOUT_MS,
		signal,
	});
	if (branchResult.code === 0 && branchResult.stdout.trim() === "main") {
		return repoRoot;
	}

	const listResult = await pi.exec("git", ["worktree", "list"], { cwd: repoRoot, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal });
	if (listResult.code === 0) {
		for (const line of listResult.stdout.split("\n")) {
			const match = line.match(/^(.+?)\s+[0-9a-f]{7,40}\s+\[(.+?)\](?:\s|$)/);
			if (!match) continue;
			const [, wt, branch] = match;
			if (branch === "main") {
				return expandHome(wt.trim());
			}
		}
	}

	const cachedMain = join(stateDir(), "main-worktrees", sha256(commonDir).slice(0, 16));
	if (await fileExists(join(cachedMain, ".git"))) {
		return cachedMain;
	}
	await mkdir(dirname(cachedMain), { recursive: true });
	const addResult = await pi.exec("git", ["worktree", "add", "--detach", cachedMain, MAIN_REF], {
		cwd: repoRoot,
		timeout: 300_000,
		signal,
	});
	if (addResult.code !== 0) {
		throw new Error(
			`could not find or create a main worktree for lmtools indexing. git worktree add failed: ${cleanCommandError(addResult)}`,
		);
	}
	return cachedMain;
}

async function startBackgroundBuild(bin: string, scope: Scope, model: string): Promise<BuildJob> {
	const key = jobKey(scope);
	const jobs = jobsDir();
	await mkdir(jobs, { recursive: true });
	await mkdir(defaultIndexesDir(), { recursive: true });

	const indexPath = defaultCodeIndexPath(scope.mainWorktree, scope.area, model);
	const tmpIndexPath = `${indexPath}.building-${Date.now()}`;
	await rm(tmpIndexPath, { force: true });

	const logPath = join(jobs, `${key}.log`);
	const scriptPath = join(jobs, `${key}.sh`);
	const exitPath = jobExitPath(key);
	const finishedPath = jobFinishedPath(key);
	await rm(exitPath, { force: true });
	await rm(finishedPath, { force: true });
	await rm(logPath, { force: true });

	const command = [
		bin,
		...DEV_LMTOOLS_ARGS,
		"code",
		"index",
		"build",
		"--repo",
		scope.mainWorktree,
		"--path-filter",
		scope.area,
		"--first-parent-ref",
		MAIN_REF,
		"--out",
		tmpIndexPath,
	];

	const script = `#!/bin/bash
set -uo pipefail
{
  echo "[lmtools-code] started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[lmtools-code] area ${shellQuote(scope.area)}"
  echo "[lmtools-code] main_worktree ${shellQuote(scope.mainWorktree)}"
  echo "[lmtools-code] main_sha ${shellQuote(scope.mainSha)}"
  echo "[lmtools-code] tmp_index ${shellQuote(tmpIndexPath)}"
  echo "[lmtools-code] final_index ${shellQuote(indexPath)}"
} >> ${shellQuote(logPath)} 2>&1
${shellJoin(command)} >> ${shellQuote(logPath)} 2>&1
code=$?
if [ "$code" -eq 0 ]; then
  mv -f ${shellQuote(tmpIndexPath)} ${shellQuote(indexPath)} >> ${shellQuote(logPath)} 2>&1
  code=$?
fi
if [ "$code" -ne 0 ]; then
  echo "[lmtools-code] build failed with exit $code" >> ${shellQuote(logPath)} 2>&1
else
  echo "[lmtools-code] build succeeded" >> ${shellQuote(logPath)} 2>&1
fi
date -u +%Y-%m-%dT%H:%M:%SZ > ${shellQuote(finishedPath)}
echo "$code" > ${shellQuote(exitPath)}
exit "$code"
`;
	await writeFile(scriptPath, script, "utf8");
	await chmod(scriptPath, 0o755);

	const child = spawn("/bin/bash", [scriptPath], {
		cwd: LMTOOLS_REPO,
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	const job: BuildJob = {
		schemaVersion: 1,
		key,
		area: scope.area,
		commonDir: scope.commonDir,
		currentRepoRoot: scope.currentRepoRoot,
		mainWorktree: scope.mainWorktree,
		mainSha: scope.mainSha,
		repoName: scope.repoName,
		model,
		indexPath,
		tmpIndexPath,
		logPath,
		scriptPath,
		pid: child.pid ?? -1,
		startedAt: new Date().toISOString(),
		lmtoolsBin: bin,
		command,
	};
	await writeFile(jobPath(key), `${JSON.stringify(job, null, 2)}\n`, "utf8");
	return job;
}

async function readJobState(scope: Scope): Promise<JobState> {
	const key = jobKey(scope);
	let job: BuildJob;
	try {
		job = JSON.parse(await readFile(jobPath(key), "utf8")) as BuildJob;
	} catch {
		return { state: "none" };
	}

	const exitCode = await readExitCode(jobExitPath(key));
	const finishedAt = await readOptionalText(jobFinishedPath(key));
	if (exitCode !== undefined) {
		if (exitCode === 0 && (await fileExists(job.indexPath))) {
			return { state: "succeeded", job, exitCode, finishedAt };
		}
		return { state: "failed", job, exitCode, finishedAt };
	}
	if (job.pid > 0 && isPidAlive(job.pid)) {
		return { state: "running", job };
	}
	if (await fileExists(job.indexPath)) {
		return { state: "succeeded", job, exitCode: 0, finishedAt };
	}
	return { state: "failed", job, stale: true, finishedAt };
}

async function formatIndexStatus(
	pi: ExtensionAPI,
	scope: Scope,
	tailLines: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const bin = await resolveLmtoolsBin(pi, signal);
	const state = await readJobState(scope);
	const sections: string[] = [];

	sections.push(`area:          ${scope.area}`);
	sections.push(`main_worktree: ${scope.mainWorktree}`);
	sections.push(`main_sha:      ${shortSha(scope.mainSha)}`);

	let indexPath = state.state === "none" ? undefined : state.job.indexPath;
	if (!indexPath) {
		const model = await tryCurrentEmbedModel(pi, bin, signal);
		if (model) {
			indexPath = defaultCodeIndexPath(scope.mainWorktree, scope.area, model);
		}
	}
	if (indexPath) {
		sections.push(`index:         ${indexPath}`);
	}

	if (state.state === "running") {
		sections.push(`build_state:   running (pid ${state.job.pid}, started ${state.job.startedAt})`);
		sections.push(`log:           ${state.job.logPath}`);
		sections.push(await formatLogTail(state.job.logPath, tailLines));
		return sections.filter(Boolean).join("\n");
	}
	if (state.state === "succeeded") {
		sections.push(`build_state:   succeeded (finished ${state.finishedAt ?? "unknown"})`);
		sections.push(`log:           ${state.job.logPath}`);
		const status = await runOptionalIndexStatus(pi, bin, state.job.indexPath, signal);
		if (status) sections.push("\nready_index:\n" + indent(status.trimEnd()));
		if (tailLines > 0) sections.push(await formatLogTail(state.job.logPath, tailLines));
		return sections.filter(Boolean).join("\n");
	}
	if (state.state === "failed") {
		const exit = state.exitCode === undefined ? "unknown" : String(state.exitCode);
		sections.push(`build_state:   failed (exit ${exit}${state.stale ? ", stale pid" : ""})`);
		sections.push(`log:           ${state.job.logPath}`);
		sections.push(await formatLogTail(state.job.logPath, tailLines));
		sections.push("\nNext search/history/map call will retry the background build if the ready index is still missing.");
		return sections.filter(Boolean).join("\n");
	}

	if (indexPath && (await fileExists(indexPath))) {
		const status = await runOptionalIndexStatus(pi, bin, indexPath, signal);
		if (status) {
			sections.push("build_state:   none (index already exists)");
			sections.push("\nready_index:\n" + indent(status.trimEnd()));
			return sections.join("\n");
		}
	}

	const selectorStatus = await runSelectorIndexStatus(pi, bin, scope, signal);
	if (selectorStatus) {
		sections.push("build_state:   none (matched existing index by selector)");
		sections.push("\nready_index:\n" + indent(selectorStatus.trimEnd()));
		return sections.join("\n");
	}

	sections.push("build_state:   none");
	sections.push("ready_index:   not found");
	sections.push("Next lmtools_code_search / lmtools_code_history / lmtools_code_map call will start a main-branch area build in the background.");
	return sections.join("\n");
}

function buildPendingResult(ensured: Extract<EnsureIndexResult, { state: "started" | "building" }>) {
	const text = [
		ensured.message,
		`area: ${ensured.scope.area}`,
		`main_worktree: ${ensured.scope.mainWorktree}`,
		`main_sha: ${shortSha(ensured.scope.mainSha)}`,
		`index: ${ensured.job.indexPath}`,
		`log: ${ensured.job.logPath}`,
		"Use lmtools_code_index_status with the same area to check progress. The requested query was not run yet.",
	].join("\n");
	return {
		content: [{ type: "text" as const, text }],
		details: { state: ensured.state, scope: ensured.scope, job: ensured.job },
	};
}

async function runLmtoolsReadTool(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	scope: Scope,
	options: CodeReadToolOptions,
) {
	const bin = await resolveLmtoolsBin(pi, signal);
	// Prepend "lmtools" to args since we're invoking via `dev lmtools`
	let executedArgs = [...DEV_LMTOOLS_ARGS, ...args];
	let result = await pi.exec(bin, executedArgs, { cwd: LMTOOLS_REPO, timeout: DEFAULT_QUERY_TIMEOUT_MS, signal });
	let rerankFallback = false;
	if (result.code !== 0 && shouldRetryWithoutRerank(executedArgs, result)) {
		rerankFallback = true;
		executedArgs = withNoRerank(executedArgs);
		result = await pi.exec(bin, executedArgs, { cwd: LMTOOLS_REPO, timeout: DEFAULT_QUERY_TIMEOUT_MS, signal });
	}
	if (result.code !== 0) {
		embedModelCache = undefined; // daemon may have died or swapped models; re-probe next call
		const hint = /lmserve daemon is not running/.test(result.stdout + result.stderr)
			? " — start it with: dev lmtools daemon install (launchd) or lmserve serve (foreground)"
			: "";
		throw new Error(`lmtools ${executedArgs.join(" ")} failed: ${cleanCommandError(result)}${hint}`);
	}

	const warnings = collectReadWarnings(result.stderr, rerankFallback);
	if (options.structured) {
		try {
			const parsed = JSON.parse(result.stdout) as unknown;
			const structured = isCodeAPIEnvelope(parsed)
				? parsed
				: normalizeCodeToolOutput(options.kind, parsed, scope, [bin, ...executedArgs], warnings);
			const raw = `${JSON.stringify(structured, null, 2)}\n`;
			const text = await truncateForTool(raw, `lmtools-${executedArgs[1] ?? "code"}`);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					area: scope.area,
					mainWorktree: scope.mainWorktree,
					mainSha: scope.mainSha,
					command: [bin, ...executedArgs],
					cwd,
					rerankFallback,
					warnings,
					schema: CODE_OUTPUT_SCHEMA_VERSION,
					result: structured,
					truncated: text.length < raw.length,
				},
			};
		} catch (err) {
			warnings.push(`Could not parse lmtools JSON output; returning raw output instead (${err instanceof Error ? err.message : String(err)}).`);
		}
	}

	const fallbackNotice = rerankFallback
		? "[lmtools-code] Rerank failed in the local lmserve daemon, so this call was retried with --no-rerank. Restart lmserve to reload the current Python environment.\n\n"
		: "";
	const raw = fallbackNotice + combineStdoutStderr(result);
	const text = await truncateForTool(raw, `lmtools-${executedArgs[1] ?? "code"}`);
	return {
		content: [{ type: "text" as const, text }],
		details: {
			area: scope.area,
			mainWorktree: scope.mainWorktree,
			mainSha: scope.mainSha,
			command: [bin, ...executedArgs],
			cwd,
			rerankFallback,
			warnings,
			truncated: text.length < raw.length,
		},
	};
}

function collectReadWarnings(stderr: string, rerankFallback: boolean): string[] {
	const warnings: string[] = [];
	if (rerankFallback) {
		warnings.push("Rerank failed in the local lmserve daemon; retried with --no-rerank.");
	}
	const cleaned = stderr.trim();
	if (cleaned) {
		warnings.push(cleaned);
	}
	return warnings;
}

function isCodeAPIEnvelope(value: unknown): boolean {
	const schema = value && typeof value === "object" ? (value as { schema?: unknown }).schema : undefined;
	return typeof schema === "string" && schema.startsWith("lmtools.code.");
}

function normalizeCodeToolOutput(kind: CodeReadToolKind, parsed: unknown, scope: Scope, command: string[], warnings: string[]) {
	switch (kind) {
		case "search":
			return normalizeSearchOutput(parsed as RawSearchResult, scope, command, warnings);
		case "history":
			return normalizeHistoryOutput(parsed as RawHistoryResult, scope, command, warnings);
		case "map":
			return normalizeMapOutput(parsed as RawMapResult, scope, command, warnings);
	}
}

function baseEnvelope(tool: string, scope: Scope, command: string[], warnings: string[]) {
	return {
		schema: CODE_OUTPUT_SCHEMA_VERSION,
		tool,
		source: "lmtools",
		scope: {
			repository: scope.repoName,
			area: scope.area,
			revision: scope.mainSha,
			worktree: scope.mainWorktree,
		},
		command,
		warnings,
	};
}

function normalizeSearchOutput(raw: RawSearchResult, scope: Scope, command: string[], warnings: string[]) {
	const envelope = baseEnvelope("code_search", scope, command, warnings);
	const groups = raw.groups && raw.groups.length > 0
		? raw.groups.map((group, groupIndex) => ({
				rank: groupIndex + 1,
				type: "file" as const,
				path: group.file_path ?? "",
				score: scoreFromGroup(group.score),
				matches: (group.hits ?? []).map((hit, hitIndex) => normalizeCodeMatch(hit, scope, raw.reranked ?? false, hitIndex + 1)),
			}))
		: (raw.hits ?? []).map((hit, hitIndex) => ({
				rank: hitIndex + 1,
				type: "file" as const,
				path: hit.file_path ?? "",
				score: scoreFromHit(hit, raw.reranked ?? false),
				matches: [normalizeCodeMatch(hit, scope, raw.reranked ?? false, 1)],
			}));
	return {
		...envelope,
		mode: raw.mode ?? "unknown",
		reranked: raw.reranked ?? false,
		seed: raw.seed ? normalizeCodeMatch(raw.seed, scope, false, 0) : undefined,
		count: groups.length,
		match_count: groups.reduce((sum, group) => sum + group.matches.length, 0),
		results: groups,
	};
}

function normalizeHistoryOutput(raw: RawHistoryResult, scope: Scope, command: string[], warnings: string[]) {
	const envelope = baseEnvelope("code_history", scope, command, warnings);
	const results = (raw.hits ?? []).map((hit, index) => ({
		rank: index + 1,
		commit: normalizeCommit(hit.sha, hit.committed_at, hit.subject, hit.merged_by_sha),
		pull_request: normalizePullRequest(hit.pr_number, hit.pr_title, hit.pr_description),
		score: scoreFromHit(hit, raw.reranked ?? false),
		hunks: (hit.hunks ?? []).map((hunk) => normalizeHistoryHunk(hunk, scope)),
	}));
	return {
		...envelope,
		mode: raw.mode ?? "unknown",
		reranked: raw.reranked ?? false,
		anchor: normalizeHistoryAnchor(raw, scope),
		count: results.length,
		results,
	};
}

function normalizeMapOutput(raw: RawMapResult, scope: Scope, command: string[], warnings: string[]) {
	const envelope = baseEnvelope("code_map", scope, command, warnings);
	const buckets = (raw.buckets ?? []).map((bucket) => {
		const relations = (bucket.hits ?? []).map((hit, index) => normalizeMapRelation(hit, bucket.name ?? hit.bucket ?? "unknown", scope, index + 1));
		return {
			name: bucket.name ?? "unknown",
			relation_kind: relationKindForBucket(bucket.name),
			suppressed: bucket.suppressed ?? false,
			count: relations.length,
			relations,
		};
	});
	return {
		...envelope,
		mode: raw.mode ?? "unknown",
		reranked: raw.reranked ?? false,
		target: raw.seed ? normalizeMapSeed(raw.seed, scope) : undefined,
		contributing_commits: {
			considered: raw.contributing_commits_considered ?? 0,
			kept: raw.contributing_commits_kept ?? 0,
		},
		notes: raw.notes ?? [],
		count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
		buckets,
	};
}

function normalizeCodeMatch(hit: RawCodeHit, scope: Scope, reranked: boolean, rank: number) {
	const location = codeLocation(scope, hit.file_path, hit.line_start, hit.line_end);
	return {
		rank,
		type: "code_match" as const,
		location,
		target: codeTarget(location, hit.symbol),
		symbol: normalizeSymbol(hit.symbol),
		snippet: hit.surviving_text ?? "",
		score: scoreFromHit(hit, reranked),
		provenance: {
			commit: normalizeCommit(hit.sha, hit.committed_at, undefined, hit.merged_by_sha),
			pull_request: normalizePullRequest(hit.pr_number, hit.pr_title, hit.pr_description),
		},
		metadata: {
			tier: hit.tier,
			cluster_id: hit.cluster_id,
			lexical_only: hit.lexical_only,
			path_score: hit.path_score,
			symbol_score: hit.symbol_score,
			text_score: hit.text_score,
		},
	};
}

function normalizeHistoryHunk(
	hunk: NonNullable<NonNullable<RawHistoryResult["hits"]>[number]["hunks"]>[number],
	scope: Scope,
) {
	const start = hunk.new_start ?? 0;
	const end = start > 0 ? start + Math.max(0, (hunk.new_lines ?? 1) - 1) : 0;
	const location = codeLocation(scope, hunk.file_path, start, end);
	return {
		location,
		target: codeTarget(location, hunk.symbol),
		symbol: normalizeSymbol(hunk.symbol),
		diff: hunk.hunk_text ?? "",
		intro_commit: hunk.intro_sha ? { sha: hunk.intro_sha, short_sha: shortSha(hunk.intro_sha) } : undefined,
		hunk_seq: hunk.hunk_seq,
		old_range: {
			start_line: hunk.old_start ?? 0,
			line_count: hunk.old_lines ?? 0,
		},
		new_range: {
			start_line: hunk.new_start ?? 0,
			line_count: hunk.new_lines ?? 0,
		},
	};
}

function normalizeMapSeed(seed: NonNullable<RawMapResult["seed"]>, scope: Scope) {
	const location = codeLocation(scope, seed.file_path, seed.line_start, seed.line_end);
	return {
		location,
		target: codeTarget(location, seed.identifier || seed.symbol),
		symbol: normalizeSymbol(seed.symbol, seed.identifier),
		snippet: seed.surviving_text ?? "",
		path_class: seed.path_class,
		cluster_id: seed.cluster_id,
		hunk_id: seed.hunk_id,
	};
}

function normalizeMapRelation(hit: NonNullable<NonNullable<RawMapResult["buckets"]>[number]["hits"]>[number], bucket: string, scope: Scope, rank: number) {
	const location = codeLocation(scope, hit.file_path, hit.line_start, hit.line_end);
	return {
		rank,
		relation_kind: relationKindForBucket(bucket),
		bucket,
		heuristic: bucket === "likely_callers" || bucket === "co_changers",
		location,
		target: codeTarget(location, hit.symbol),
		symbol: normalizeSymbol(hit.symbol),
		snippet: hit.surviving_text ?? "",
		source: hit.source,
		path_class: hit.path_class,
		cluster_id: hit.cluster_id,
		evidence: {
			co_change_count: hit.co_change_count ?? 0,
			linking_commit: hit.linking_sha ? { sha: hit.linking_sha, short_sha: shortSha(hit.linking_sha) } : undefined,
			linking_pr_title: hit.linking_pr_title,
		},
	};
}

function normalizeHistoryAnchor(raw: RawHistoryResult, scope: Scope) {
	if (raw.anchor_range) {
		const file = raw.anchor_range.File ?? raw.anchor_range.file ?? "";
		const start = raw.anchor_range.StartLine ?? raw.anchor_range.startLine ?? raw.anchor_range.start_line ?? 0;
		const end = raw.anchor_range.EndLine ?? raw.anchor_range.endLine ?? raw.anchor_range.end_line ?? start;
		return {
			type: "range" as const,
			location: codeLocation(scope, file, start, end),
		};
	}
	if (raw.anchor_symbol) {
		return {
			type: "symbol" as const,
			file_path: raw.anchor_symbol.File ?? raw.anchor_symbol.file ?? undefined,
			symbol: raw.anchor_symbol.Sym ?? raw.anchor_symbol.sym ?? "",
		};
	}
	if (raw.topic) {
		return { type: "topic" as const, query: raw.topic };
	}
	return undefined;
}

function codeLocation(scope: Scope, filePath: string | undefined, startLine: number | undefined, endLine: number | undefined): CodeLocation {
	const path = filePath ?? "";
	const start = startLine && startLine > 0 ? startLine : 0;
	const end = endLine && endLine > 0 ? endLine : start;
	const absPath = path ? join(scope.mainWorktree, path) : scope.mainWorktree;
	return {
		uri: pathToFileURL(absPath).href,
		path,
		start_line: start,
		end_line: end,
		range: {
			start: { line: start, character: 0 },
			end: { line: end, character: 0 },
			line_base: 1,
			character_base: 0,
		},
	};
}

function codeTarget(location: CodeLocation, symbolText: string | undefined): string {
	const name = symbolNameFromText(symbolText) || bareIdentifier(symbolText);
	if (location.path && name) return `${location.path}::${name}`;
	if (location.path && location.start_line > 0) return `${location.path}:${location.start_line}-${location.end_line}`;
	return location.path;
}

function normalizeSymbol(symbolText: string | undefined, explicitName?: string) {
	if (!symbolText && !explicitName) return undefined;
	return {
		name: explicitName || symbolNameFromText(symbolText),
		signature: symbolText ?? explicitName ?? "",
	};
}

function symbolNameFromText(symbolText: string | undefined): string | undefined {
	if (!symbolText) return undefined;
	if (bareIdentifier(symbolText)) return bareIdentifier(symbolText);
	const text = symbolText.trim();
	const patterns = [
		/\b(?:function|class|interface|type|enum|const|let|var|fun|struct|protocol)\s+([A-Za-z_$][\w$]*)/,
		/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(?/,
		/\b([A-Za-z_$][\w$]*)\s*\(/,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

function bareIdentifier(symbolText: string | undefined): string | undefined {
	const text = symbolText?.trim();
	if (!text) return undefined;
	return /^[A-Za-z_$][\w$]*$/.test(text) ? text : undefined;
}

function normalizeCommit(sha: string | undefined, committedAt?: number, subject?: string, mergedBySha?: string) {
	if (!sha && !committedAt && !subject && !mergedBySha) return undefined;
	return {
		sha,
		short_sha: sha ? shortSha(sha) : undefined,
		committed_at: unixSecondsToISO(committedAt),
		subject,
		merged_by_sha: mergedBySha,
	};
}

function normalizePullRequest(prNumber: number | undefined, title?: string, description?: string) {
	if (!prNumber && !title && !description) return undefined;
	return {
		number: prNumber || undefined,
		title,
		description,
	};
}

function scoreFromGroup(score: number | undefined): CodeScore {
	if (score === undefined) return { kind: "none", direction: "none" };
	return { kind: "group", value: score, direction: "higher_is_better" };
}

function scoreFromHit(hit: { rerank_score?: number; hybrid_score?: number; distance?: number }, reranked: boolean): CodeScore {
	if (reranked && hit.rerank_score !== undefined) {
		return { kind: "rerank", value: hit.rerank_score, direction: "higher_is_better", distance: hit.distance, hybrid: hit.hybrid_score };
	}
	if (hit.hybrid_score !== undefined && hit.hybrid_score !== 0) {
		return { kind: "hybrid", value: hit.hybrid_score, direction: "higher_is_better", distance: hit.distance };
	}
	if (hit.distance !== undefined) {
		return { kind: "distance", value: hit.distance, direction: "lower_is_better" };
	}
	return { kind: "none", direction: "none" };
}

function relationKindForBucket(bucket: string | undefined): string {
	switch (bucket) {
		case "self":
			return "definition";
		case "internal":
			return "same_file";
		case "likely_callers":
			return "reference";
		case "co_changers":
			return "co_change";
		case "tests":
			return "test";
		case "stories":
			return "story";
		case "generated":
			return "generated";
		case "docs":
			return "documentation";
		case "i18n":
			return "localization";
		case "other":
			return "other";
		default:
			return bucket ?? "unknown";
	}
}

function unixSecondsToISO(value: number | undefined): string | undefined {
	if (!value || value <= 0) return undefined;
	return new Date(value * 1000).toISOString();
}

function shouldRetryWithoutRerank(args: string[], result: Pick<ExecResult, "stdout" | "stderr">): boolean {
	if (args.includes("--no-rerank")) return false;
	if (args[0] !== "code" || !["search", "history", "map"].includes(args[1] ?? "")) return false;
	const output = `${result.stdout}\n${result.stderr}`;
	return output.includes("code search: rerank") || output.includes("code history: rerank") || output.includes("code map: rerank") ||
		(output.includes("rerank:") && output.includes("ImportError"));
}

function withNoRerank(args: string[]): string[] {
	return [args[0], args[1], "--no-rerank", ...args.slice(2)];
}

type LabelUpdate = (update: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void;

// Shows `label` while `work` (a CLI child) runs, polling lmserve so a
// call stuck behind other model work says so. queue_depth counts this
// call's own in-flight request, so only depth > 1 means waiting.
async function withGpuQueueLabel<T>(onUpdate: LabelUpdate | undefined, label: string, work: () => Promise<T>): Promise<T> {
	const show = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
	show(label);
	let running = true;
	void (async () => {
		let shown = label;
		while (running) {
			const depth = await daemonQueueDepth();
			const next = depth !== undefined && depth > 1 ? `Waiting for GPU queue (${depth} pending)...` : label;
			if (running && next !== shown) show((shown = next));
			await new Promise((resolve) => setTimeout(resolve, GPU_QUEUE_POLL_MS));
		}
	})();
	try {
		return await work();
	} finally {
		running = false;
	}
}

// One `status` round-trip on lmserve's socket — answered on the daemon's
// event loop, never queued behind GPU work, so far cheaper than spawning
// `dev lmtools daemon status`. Frame: "LMSV" + u32 BE length + JSON.
// Resolves undefined on any failure (daemon down, old daemon, timeout).
function daemonQueueDepth(): Promise<number | undefined> {
	return new Promise((resolve) => {
		const sock = connect(LMSERVE_SOCKET);
		let buf = Buffer.alloc(0);
		const finish = (depth?: number) => {
			sock.destroy();
			resolve(depth);
		};
		sock.setTimeout(1_000, () => finish());
		sock.on("error", () => finish());
		sock.on("connect", () => {
			const body = Buffer.from(JSON.stringify({ op: "status" }));
			const header = Buffer.alloc(8);
			header.write("LMSV", 0, "ascii");
			header.writeUInt32BE(body.length, 4);
			sock.write(Buffer.concat([header, body]));
		});
		sock.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length < 8 || buf.length < 8 + buf.readUInt32BE(4)) return;
			try {
				const { queue_depth } = JSON.parse(buf.subarray(8, 8 + buf.readUInt32BE(4)).toString()) as { queue_depth?: unknown };
				finish(typeof queue_depth === "number" ? queue_depth : undefined);
			} catch {
				finish();
			}
		});
	});
}

async function resolveLmtoolsBin(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<string> {
	// Always use the dev wrapper — `dev lmtools` builds from source
	// via the go-run wrapper in result/bin/lmtools, ensuring the
	// extension always runs current code. The binary must run from
	// the lmtools repo dir (dev.yml lives there).
	if (await isExecutable(DEV_BIN)) {
		return DEV_BIN;
	}
	throw new Error(
		`Could not find dev at ${DEV_BIN}. lmtools-code requires the dev wrapper to invoke lmtools.`,
	);
}

async function which(pi: ExtensionAPI, command: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	const result = await pi.exec("/usr/bin/which", [command], { timeout: DEFAULT_STATUS_TIMEOUT_MS, signal });
	if (result.code === 0) {
		const out = result.stdout.trim();
		if (out) return out;
	}
	return undefined;
}

async function currentEmbedModel(pi: ExtensionAPI, bin: string, signal: AbortSignal | undefined): Promise<string> {
	const model = await tryCurrentEmbedModel(pi, bin, signal);
	if (!model) {
		throw new Error("lmserve is not reporting a loaded embed model; start lmserve with `lmtools daemon install`/`lmtools daemon restart`.");
	}
	return model;
}

async function tryCurrentEmbedModel(pi: ExtensionAPI, bin: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	if (embedModelCache && Date.now() - embedModelCache.at < EMBED_MODEL_TTL_MS) return embedModelCache.model;
	const model = await probeEmbedModel(pi, bin, signal);
	embedModelCache = model ? { model, at: Date.now() } : undefined;
	return model;
}

async function probeEmbedModel(pi: ExtensionAPI, bin: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	const result = await pi.exec(bin, [...DEV_LMTOOLS_ARGS, "daemon", "status"], { cwd: LMTOOLS_REPO, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal });
	if (result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as { models?: Array<{ id?: string; kind?: string; loaded?: boolean }> };
		const loaded = parsed.models?.find((model) => model.kind === "embed" && model.loaded && model.id)?.id;
		if (loaded) return loaded;
		return parsed.models?.find((model) => model.kind === "embed" && model.id)?.id;
	} catch {
		return undefined;
	}
}

async function runOptionalIndexStatus(
	pi: ExtensionAPI,
	bin: string,
	indexPath: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (!(await fileExists(indexPath))) return undefined;
	const result = await pi.exec(bin, [...DEV_LMTOOLS_ARGS, "code", "index", "status", "--index", indexPath], {
		cwd: LMTOOLS_REPO,
		timeout: DEFAULT_STATUS_TIMEOUT_MS,
		signal,
	});
	if (result.code !== 0) return undefined;
	return combineStdoutStderr(result);
}

async function runSelectorIndexStatus(
	pi: ExtensionAPI,
	bin: string,
	scope: Scope,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const result = await pi.exec(
		bin,
		[...DEV_LMTOOLS_ARGS, "code", "index", "status", "--index-repo", scope.repoName, "--index-path-filter", scope.area],
		{ cwd: LMTOOLS_REPO, timeout: DEFAULT_STATUS_TIMEOUT_MS, signal },
	);
	if (result.code !== 0) return undefined;
	return combineStdoutStderr(result);
}

function defaultCodeIndexPath(repoRoot: string, area: string, model: string): string {
	const parts = [basename(repoRoot), sanitiseTag(area), sanitiseTag(model)].filter(Boolean);
	parts[parts.length - 1] = `${parts[parts.length - 1]}.sqlite`;
	return join(defaultIndexesDir(), parts.join("-"));
}

function sanitiseTag(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, "_").replace(/^_+|_+$/g, "");
}

function defaultIndexesDir(): string {
	return join(userCacheHome(), "lmtools", "indexes");
}

function stateDir(): string {
	return join(userCacheHome(), "lmtools", "pi-code-extension");
}

function jobsDir(): string {
	return join(stateDir(), "jobs");
}

function userCacheHome(): string {
	if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
	if (platform() === "darwin") return join(homedir(), "Library", "Caches");
	return join(homedir(), ".cache");
}

function jobKey(scope: Pick<Scope, "commonDir" | "area">): string {
	return sha256(`${scope.commonDir}\n${scope.area}`).slice(0, 24);
}

function jobPath(key: string): string {
	return join(jobsDir(), `${key}.json`);
}

function jobExitPath(key: string): string {
	return join(jobsDir(), `${key}.exit`);
}

function jobFinishedPath(key: string): string {
	return join(jobsDir(), `${key}.finished`);
}

async function formatLogTail(logPath: string, tailLines: number): Promise<string> {
	if (tailLines <= 0) return "";
	const tail = await tailFile(logPath, tailLines);
	if (!tail.trim()) return "\nbuild_log_tail: (empty)";
	return `\nbuild_log_tail:\n${indent(tail.trimEnd())}`;
}

async function tailFile(path: string, maxLines: number, maxBytes = 64 * 1024): Promise<string> {
	try {
		const st = await stat(path);
		const bytes = Math.min(st.size, maxBytes);
		const fh = await open(path, "r");
		try {
			const buffer = Buffer.alloc(bytes);
			await fh.read(buffer, 0, bytes, st.size - bytes);
			return buffer.toString("utf8").split("\n").slice(-maxLines).join("\n");
		} finally {
			await fh.close();
		}
	} catch {
		return "";
	}
}

async function truncateForTool(output: string, prefix: string): Promise<string> {
	const truncation = truncateHead(output, { maxLines: MAX_RETURN_LINES, maxBytes: MAX_RETURN_BYTES });
	if (!truncation.truncated) return truncation.content;

	const dir = join(stateDir(), "outputs");
	await mkdir(dir, { recursive: true });
	const fullOutputPath = join(dir, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
	await withFileMutationQueue(fullOutputPath, async () => {
		await writeFile(fullOutputPath, output, "utf8");
	});
	return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
}

function combineStdoutStderr(result: Pick<ExecResult, "stdout" | "stderr">): string {
	const stdout = result.stdout.trimEnd();
	const stderr = result.stderr.trimEnd();
	if (stdout && stderr) return `${stdout}\n\n[stderr]\n${stderr}`;
	return stdout || stderr || "(no output)";
}

function cleanCommandError(result: Pick<ExecResult, "stdout" | "stderr" | "code" | "killed">): string {
	const out = combineStdoutStderr(result);
	const killed = result.killed ? " (killed)" : "";
	return `exit ${result.code}${killed}: ${out}`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readExitCode(path: string): Promise<number | undefined> {
	const text = await readOptionalText(path);
	if (text === undefined) return undefined;
	const n = Number.parseInt(text.trim(), 10);
	return Number.isFinite(n) ? n : undefined;
}

async function readOptionalText(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch {
		return undefined;
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return resolvePath(homedir(), path.slice(2));
	return path;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellJoin(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function shortSha(sha: string): string {
	return sha.length > 8 ? sha.slice(0, 8) : sha;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
