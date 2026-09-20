# DeepSeek Harness

Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
0.1.5-rc.2 or newer on the machine running your environment, authenticate it in
the DSH profile, then enable **DeepSeek** in **Settings > Providers**. See
[provider setup](./install.md#providers).

T3 Code launches `dsh --profile acp`. It does not store or display DSH API keys;
keep credentials in the DeepSeek Harness profile on that machine.

## Models

The picker starts with DeepSeek V4 Flash (`deepseek-official/deepseek-v4-flash`),
the official DSH 0.1.5-rc.2 ACP default, plus any custom slugs you add. Provider
status checks `dsh --version` and ACP `initialize` only; that does not log in or
load the live catalog. After a DeepSeek session has started, **Refresh provider
status** includes models discovered from that session's `session/set_config_option`
catalog. Existing threads keep their selected model even if it leaves the catalog;
if DSH rejects it, choose an available model and retry.

Reasoning effort is sent as DSH's `session/set_config_option` `reasoning_effort`
value. Leave it unset to keep the model's provider default.

## Approvals

DeepSeek Harness follows the shared [permission modes](./permission-modes.md).
**Full access** sets DSH to `danger-full-access`. Other modes use
`workspace-write` and still ask. DSH permission prompts are one-shot allow or
reject; there is no "always allow this session" option.

## Sessions

T3 resumes a DeepSeek thread with ACP `session/resume`. DSH does not replay old
transcript updates on resume and does not support provider-side rollback.

## Troubleshooting

If the provider card says DeepSeek is not installed, put `dsh` on `PATH` or set
**Binary path**. A successful initialize does not mean T3 has DSH credentials;
those stay in the DSH profile and are checked when a session starts. If it
reports an incompatible developer preview, upgrade `dsh` to 0.1.5-rc.2 or newer.
T3 will not fall back to another provider's ACP dialect.
