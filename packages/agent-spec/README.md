# @endo/agent-spec

Prototype package for declaring Endo agents as hardened object graphs instead
of stringly typed configuration records.

The package does two small things:

1. Exports provisional interface guards for agent assembly components such as
   lifecycle managers, ingress adapters, roles, orchestrators, adoption
   policies, and authority providers.
2. Exports `defineAgent()` and `describeAgent()` to keep a declaration as real
   object references while still producing an inspectable contributor-facing
   summary through each component's `help()` method.

This spike intentionally does **not** implement a new agent loop. If
`pi-agent-core` becomes the standard inner harness, Pi should own the per-role
tool loop while Endo-owned components provide tools, authority, ingress,
lifecycle, and policy around it.

```js
const mainRole = makePiRole({
  model,
  tools,
  transcript,
});

const fae = defineAgent({
  name: 'fae',
  lifecycle,
  ingress: [inboxIngress],
  roles: { main: mainRole },
  orchestrator: makeSingleRoleOrchestrator({ role: mainRole }),
  adoption: mailAdoptionPolicy,
  authority: ambientAuthorityProvider,
  tools: { builtins: tools },
});
```

The important part of the shape is that `lifecycle`, `mainRole`, `inboxIngress`,
`mailAdoptionPolicy`, and `ambientAuthorityProvider` are objects or
capabilities, not enum strings. Their behavior stays attached to the references
that were declared.
