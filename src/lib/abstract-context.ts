/**
 * What Abstract sells, for prompts. Every fact here comes from docs.abstract.inc,
 * abstract.inc or the interview prep notes (Nov 2026). Keep it factual: drafts
 * may only claim what is written here or found about the lead.
 */
export const ABSTRACT_CONTEXT = `
ABOUT ABSTRACT (the company the sender works for)
- Abstract sells one API key for hosted robot action models (VLAs) and cheap open-source LLMs, all running on its own GPUs. Site: abstract.inc. Docs: docs.abstract.inc. Keys: platform.abstract.inc.
- Robot request: camera frames + robot state + a task in plain English in; the robot's next action chunk out (POST /v1/get_action).
- Robot models served (8):
  - allenai/molmoact2 (MolmoAct2): bimanual YAM, 30 action rows per chunk, 30 Hz
  - microsoft/rho (Rho): bimanual YAM, 25 rows, 15 Hz
  - perceptron/isaac-0.5 (Isaac 0.5): bimanual YAM, 30 rows, 30 Hz
  - physical-intelligence/pi0.5 (pi0.5, a community fine-tune lane): bimanual YAM, 30 rows, 30 Hz
  - runway/praxis-1 (Praxis-1): bimanual YAM, keeps episode memory, 15 Hz
  - verne/v0.5 (Verne V0.5): bimanual YAM, keeps episode memory, 30 Hz
  - xiaomi/xiaomi-robotics-1 (Xiaomi Robotics 1): two ARX X5 arms, 25 Hz
  - black-forest-labs/flux-3-action (FLUX 3 Action): Franka Panda (DROID), 15 Hz
- Supported robots: bimanual YAM (most models), ARX X5 (Xiaomi), Franka Panda / DROID (FLUX).
- Deployments: your own copy of a model held on a GPU for your robot, so episodes never wait for room and never wait for a cold start. You pay for chunks; idle time is covered up to 4 hours per UTC day per model.
- Your own checkpoint: a team can deploy its own fine-tune from a public Hugging Face repo. An inspect check (POST /v1/models/inspect) says whether it can be served, which model lane runs it, the GPU memory it needs and its rates. It downloads no weights and starts no GPU. Served fine-tune bases: MolmoAct2-BimanualYAM, LeRobot pi05 (three cameras, 14-value state, 30 actions), Verne v0.5-base, Praxis-1-yam, Rho-yam-box, FLUX 3 Action DROID, Xiaomi XR-1 for ARX X5, Isaac 0.5. openpi checkpoints are not served.
- Billing: pay per use (per input token and per action row), optional monthly spend caps, and a new account starts with $5 of API credit. Hourly cost depends on the model and control rate; never quote a robot-hour price unless it comes from an inspect result.
- Open LLMs: DeepSeek V4.1 Flash, Kimi K3.1, GLM 5.3 and GLM 5.3 Flash through an OpenAI-compatible Chat Completions API.
- GPU rental: H100, B200, B300 and GB300 from $2.49 an hour.
- Developer experience: the abstract CLI (abstract login, abstract skill install) adds an Abstract skill to Claude Code, Codex, Cursor, OpenCode, Gemini CLI and GitHub Copilot. The Python client (abstract-client) has a RobotClient with the same calls as Dream Labs' DreamClient.
- Connect: an OAuth flow that lets other apps bill their users' Abstract accounts.
- Founder-led sales: "Contact sales" books a 30-minute call with the team.

COMPETITION (as of Nov 2026)
- Physical Intelligence: Pi API beta since Oct 13, 2026, access by application, only its own models.
- Dream Labs: Dream-1 through an API at $3 an hour, only its own model.
- Dreamscale Labs (YC Fall 2026): robot inference at $5 per robot-hour.
- Self-hosting: Playground Serve (open source) runs pi0.5, MolmoAct2, GR00T and others on serverless GPUs in your own cloud.
- Abstract's edge: one API for many labs' models, deploy-your-own-checkpoint, dedicated deployments without cold starts, plus cheap open LLMs and GPUs.
`.trim();

/** The angle library the writer chooses from. ids are stable. */
export const ANGLE_LIBRARY = [
  {
    id: "checkpoint-runs-here",
    name: "Your checkpoint runs here",
    when: "They publish a fine-tune of a model Abstract serves (Hugging Face) or train on YAM, ARX X5 or Franka/DROID.",
  },
  {
    id: "drop-onboard-gpu",
    name: "Drop the onboard GPU",
    when: "They run policies on the robot (Jetson, onboard compute) or mention latency, weight, power or cost of onboard inference.",
  },
  {
    id: "one-key-many-models",
    name: "One key, eight models",
    when: "They compare or switch between robot models, or evaluate VLAs.",
  },
  {
    id: "no-cold-starts",
    name: "No cold starts",
    when: "They are moving into deployment, pilots or customer sites and need a model that stays loaded.",
  },
  {
    id: "open-llms-for-less",
    name: "Open LLMs for less",
    when: "They spend on open LLMs such as DeepSeek, Kimi or GLM, or build LLM products.",
  },
  {
    id: "gpus-for-less",
    name: "GPUs for less",
    when: "They train or fine-tune and rent H100/B200-class GPUs, or own idle GPU capacity.",
  },
] as const;

export type AngleId = (typeof ANGLE_LIBRARY)[number]["id"];
