import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Harnesses whose logins stay apart from the machine setup in a profile (`research/profile-logins.md`,
 * #18). The room offers profiles only for these; the bridge refuses any other, or none, itself. Codex,
 * Grok Build, Cursor, Hermes Agent, Antigravity and plain shells use the machine setup only.
 */
export const PROFILE_HARNESSES: ReadonlySet<string> = new Set(["claude-code", "opencode"]);
/**
 * Each harness's folder variable, pointed into the profile. Codex and Grok Build can't use a profile
 * yet; their variables are kept for when they can. Two-account separation is still unverified (#18).
 */
export const PROFILE_FOLDERS = {
  CLAUDE_CONFIG_DIR: "claude",
  CODEX_HOME: "codex",
  GROK_HOME: "grok",
  // OpenCode keeps config, logins, caches and state under these four.
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  T3CODE_HOME: "t3code",
} as const;
/**
 * Switches every profile terminal gets. OpenCode would otherwise load skills from the machine's
 * `~/.claude` and `~/.agents`; `OPENCODE_DISABLE_CLAUDE_CODE` also stops its Claude Code prompt import
 * (OpenCode 1.19.5 `runtime-flags.ts`).
 */
export const PROFILE_SWITCHES = {
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
} as const;
/**
 * Machine sign-ins a profile terminal must not inherit, by the harness that reads them. Without
 * this a profile terminal would sign in as whoever started the bridge, whatever its own folders
 * hold (`research/profile-logins.md`, Claude Code section). Machine-setup terminals keep them all.
 */
export const MACHINE_AUTH_VARIABLES = {
  // Claude Code: credentials and provider selection, from its environment variable reference
  // (code.claude.com/docs/en/env-vars) and authentication precedence
  // (code.claude.com/docs/en/authentication#authentication-precedence).
  "claude-code": [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_MANTLE",
  ],
  // OpenCode 1.19.5 (commit 810c0eb): its own login, config and database overrides
  // (`auth/index.ts`, `config/config.ts`, core `database/database.ts`, `server/auth.ts`, core
  // `plugin/provider/opencode.ts`).
  opencode: [
    "OPENCODE_AUTH_CONTENT", "OPENCODE_API_KEY", "OPENCODE_CONSOLE_TOKEN", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD",
  ],
  // OpenCode signs in to a provider with the first of that provider's `env` names that is set
  // (`provider/provider.ts` line 1641). These are every provider's names in models.dev/api.json
  // on 2026-11-02; regenerate from there when OpenCode adds providers.
  "opencode-providers": [
    "302AI_API_KEY", "ABACUS_API_KEY", "ABLIT_KEY", "ABOVE_API_KEY", "AGENTROUTER_API_KEY",
    "AGNES_API_KEY", "AI21_API_KEY", "AIAND_API_KEY", "AICORE_SERVICE_KEY", "AIHUBMIX_API_KEY",
    "AIMLAPI_API_KEY", "AINETCAFE_API_KEY", "AIXY_API_KEY", "AI_GATEWAY_API_KEY",
    "AI_ROUTER_API_KEY", "AKI_IO_API_KEY", "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_TOKEN_PLAN_API_KEY", "AMBIENT_API_KEY", "AMD_API_KEY", "ANTHROPIC_API_KEY",
    "ANYAPI_API_KEY", "ARCEE_API_KEY", "ARK_API_KEY", "ARK_CODING_PLAN_API_KEY",
    "ATOMIC_CHAT_API_KEY", "AURIKO_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AZURE_API_KEY", "AZURE_COGNITIVE_SERVICES_API_KEY",
    "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_RESOURCE_NAME", "BAILING_API_TOKEN",
    "BASETEN_API_KEY", "BEE_API_KEY", "BERGET_API_KEY", "BLUECLAW_API_KEY", "BOTHUB_API_KEY",
    "BOUNDLESS_API_KEY", "CEREBRAS_API_KEY", "CHUTES_API_KEY", "CLARIFAI_PAT", "CLAUDINIO_API_KEY",
    "CLINE_API_KEY", "CLOUDFERRO_SHERLOCK_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_GATEWAY_ID", "CMD_API_KEY", "COHERE_API_KEY",
    "CORAL_API_KEY", "CORTECS_API_KEY", "CROSSMODEL_API_KEY", "CRUSOE_API_KEY", "DAOXE_API_KEY",
    "DASHSCOPE_API_KEY", "DATABRICKS_HOST", "DATABRICKS_TOKEN", "DEEPINFRA_API_KEY",
    "DEEPSEEK_API_KEY", "DIGITALOCEAN_ACCESS_TOKEN", "DINFERENCE_API_KEY", "DRUN_API_KEY",
    "EBCLOUD_API_KEY", "ECHO_API_KEY", "EDENAI_API_KEY", "EMPIRIOLABS_API_KEY", "ENGY_API_KEY",
    "EVROC_API_KEY", "FASTROUTER_API_KEY", "FIREWORKS_API_KEY", "FREEMODEL_API_KEY",
    "FRIENDLI_TOKEN", "FROGBOT_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "GITLAB_TOKEN",
    "GMICLOUD_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_VERTEX_LOCATION", "GOOGLE_VERTEX_PROJECT",
    "GREENPT_API_KEY", "GROQ_API_KEY", "HELICONE_API_KEY", "HETZNER_API_KEY", "HF_TOKEN",
    "HOPPER_API_KEY", "HPC_AI_API_KEY", "HYPER_API_KEY", "IMPOSSIBL_API_KEY", "INCEPTION_API_KEY",
    "INCEPTRON_API_KEY", "INCO_API_KEY", "INFERENCE_API_KEY", "INFERX_API_KEY", "INFER_API_KEY",
    "INFOMANIAK_API_KEY", "INFOMANIAK_PRODUCT_ID", "IOINTELLIGENCE_API_KEY", "ITERACOMPUTE_API_KEY",
    "JALAPENO_API_KEY", "JIEKOU_API_KEY", "KENARI_API_KEY", "KILO_API_KEY", "KIMI_API_KEY",
    "KLOKINTEGRATION_API_KEY", "KOSMIK_API_KEY", "KUAE_API_KEY", "LILAC_API_KEY", "LIQUID_API_KEY",
    "LLMGATEWAY_API_KEY", "LLMTECH_API_KEY", "LLMTR_API_KEY", "LMSTUDIO_API_KEY", "LONGCAT_API_KEY",
    "LOWROUTER_API_KEY", "LUCIDQUERY_API_KEY", "LYNKR_API_KEY", "MEGANOVA_API_KEY",
    "MELIOUS_API_KEY", "MERGE_GATEWAY_API_KEY", "META_MODEL_API_KEY", "MINIMAX_API_KEY",
    "MISTRAL_API_KEY", "MIXLAYER_API_KEY", "MOARK_API_KEY", "MODAL_PROXY_TOKEN", "MODELIS_API_KEY",
    "MODELSCOPE_API_KEY", "MODEL_ORACLE_API_KEY", "MODULAR_API_KEY", "MOONSHOT_API_KEY",
    "MORPH_API_KEY", "MUNITO_API_KEY", "NANO_GPT_API_KEY", "NAN_API_KEY", "NEARAI_API_KEY",
    "NEBIUS_API_KEY", "NEON_AI_GATEWAY_BASE_URL", "NEON_AI_GATEWAY_TOKEN", "NEOSMITH_API_KEY",
    "NEURALWATT_API_KEY", "NOVA_API_KEY", "NOVITA_API_KEY", "NVIDIA_API_KEY", "OCI_GENAI_API_KEY",
    "OFOX_API_KEY", "OLLAMA_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY", "OPENREASON_API_KEY",
    "OPENROUTER_API_KEY", "OPPER_API_KEY", "ORCAROUTER_API_KEY", "OVHCLOUD_API_KEY",
    "PARETO_API_KEY", "PENDRA_API_KEY", "PERPLEXITY_API_KEY", "PIONEER_API_KEY", "POE_API_KEY",
    "POOLSIDE_API_KEY", "PRIME_API_KEY", "PRIVATEMODE_API_KEY", "QIHANG_API_KEY", "QINIU_API_KEY",
    "QVAC_API_KEY", "REFLECTION_API_KEY", "REGOLO_API_KEY", "REQUESTY_API_KEY",
    "ROUTING_RUN_API_KEY", "RUNINFRA_GATEWAY_KEY", "SAKANA_API_KEY", "SALAD_CLOUD_API_KEY",
    "SAMBANOVA_API_KEY", "SARVAM_API_KEY", "SCALEWAY_API_KEY", "SCNET_API_KEY", "SCX_API_KEY",
    "SENSENOVA_API_KEY", "SILICONFLOW_API_KEY", "SILICONFLOW_CN_API_KEY", "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_CORTEX_PAT", "STACKIT_API_KEY", "STANDARDCOMPUTE_API_KEY", "STEPFUN_API_KEY",
    "SUBCONSCIOUS_API_KEY", "SUBMODEL_INSTAGEN_ACCESS_KEY", "SYNTHETIC_API_KEY", "TEMPR_API_KEY",
    "TENCENT_CODING_PLAN_API_KEY", "TENCENT_TOKENHUB_API_KEY", "TENCENT_TOKEN_PLAN_API_KEY",
    "TENSORX_API_KEY", "THEGRID_API_KEY", "TINFOIL_API_KEY", "TINKER_API_KEY", "TOGETHER_API_KEY",
    "TOKENGO_API_KEY", "TOKENROUTER_API_KEY", "TRUSTEDROUTER_API_KEY", "UMANS_AI_API_KEY",
    "UMANS_AI_CODING_PLAN_API_KEY", "UNOROUTER_API_KEY", "UPSTAGE_API_KEY", "VANCINE_API_KEY",
    "VENICE_API_KEY", "VISPARK_LAB_API_KEY", "VIVGRID_API_KEY", "VULTR_API_KEY", "WAFER_API_KEY",
    "WALLABY_API_KEY", "WALLY_API_KEY", "WANDB_API_KEY", "WATSONX_AI_APIKEY",
    "WATSONX_AI_PROJECT_ID", "XAI_API_KEY", "XIAOMI_API_KEY", "XPERSONA_API_KEY", "ZELDOC_API_KEY",
    "ZENIFRA_AI_KEY", "ZENMUX_API_KEY", "ZHIPU_API_KEY",
  ],
} as const satisfies Record<string, readonly string[]>;
const MACHINE_AUTH: ReadonlySet<string> = new Set(Object.values(MACHINE_AUTH_VARIABLES).flat());
/**
 * The environment without the machine's sign-ins, for a profile terminal. Names match in any case,
 * since Windows treats `Anthropic_Api_Key` as `ANTHROPIC_API_KEY`.
 */
export function withoutMachineAuth(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !MACHINE_AUTH.has(name.toUpperCase())));
}
const METADATA = ".uplink-profile.json";
export class Profiles {
  readonly entries = new Map<string, number>();
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid profile ID");
    return join(this.root, id);
  }
  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = this.path(entry.name);
      let saved: string;
      try {
        saved = await readFile(join(dir, METADATA), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A crash during `create` left a folder with no expiry. It was never reported to the
        // room, so nothing uses it; remove it, and a replayed `create_profile` makes it again.
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      const metadata = JSON.parse(saved);
      if (!Number.isFinite(metadata.expiresAt)) throw new Error("Invalid saved profile expiry");
      this.entries.set(entry.name, metadata.expiresAt);
    }
  }
  /**
   * Makes a profile, and returns its expiry. Safe to replay: a room command delivered again after
   * a restart finds the profile already made and gets its saved expiry back.
   */
  async create(id: string, expiresAt: number): Promise<number> {
    const dir = this.path(id);
    const saved = this.entries.get(id);
    if (saved !== undefined) {
      if (await lstat(dir).then((s) => s.isDirectory(), () => false)) return saved;
      // Its folder went missing: make it again, keeping the expiry it was given.
      expiresAt = saved;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const folder of Object.values(PROFILE_FOLDERS))
      await mkdir(join(dir, folder), { recursive: true, mode: 0o700 });
    // Written last and renamed into place, so a saved expiry always means a whole profile.
    const temp = join(dir, `${METADATA}.tmp`);
    await writeFile(temp, JSON.stringify({ expiresAt }), { mode: 0o600 });
    await rename(temp, join(dir, METADATA));
    this.entries.set(id, expiresAt);
    return expiresAt;
  }
  async environment(id: string): Promise<Record<string, string>> {
    const dir = this.path(id);
    if (!this.entries.has(id) || !(await lstat(dir)).isDirectory())
      throw new Error("Profile does not exist");
    // A profile made before a folder was added gets it now.
    for (const folder of Object.values(PROFILE_FOLDERS))
      await mkdir(join(dir, folder), { recursive: true, mode: 0o700 });
    return {
      ...Object.fromEntries(
        Object.entries(PROFILE_FOLDERS).map(([variable, folder]) => [variable, join(dir, folder)]),
      ),
      ...PROFILE_SWITCHES,
    };
  }
  async delete(id: string) {
    await rm(this.path(id), { recursive: true, force: true });
    this.entries.delete(id);
  }
}
