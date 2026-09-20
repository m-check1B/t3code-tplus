# DeepSeek Harness

Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
0.1.5-rc.2 or newer on the machine running your environment, authenticate it in
the DSH profile, then enable **DeepSeek** in **Settings > Providers**. See
[provider setup](./install.md#providers).

T3 Code launches `dsh --profile acp`. It does not store or display DSH API keys;
keep credentials in the DeepSeek Harness profile on that machine.

## Models

The picker starts with DeepSeek Flash (`deepseek-official/deepseek-flash`), the
ACP profile's shipped default. Refresh provider status after changing DSH models
or adding custom slugs. Existing threads keep their selected model even if it
leaves the catalog; if DSH rejects it, choose an available model and retry.

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
**Binary path**. If it reports an incompatible developer preview, upgrade `dsh`
to 0.1.5-rc.2 or newer. T3 will not fall back to another provider's ACP dialect.
