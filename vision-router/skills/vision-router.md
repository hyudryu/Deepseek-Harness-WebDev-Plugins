# Vision Router

Use this skill for awareness of how images are handled in model requests when working with screenshots, UI imagery, or any visual content.

## What the router does

The vision-router is a transparent two-stage model router, not a tool you call directly:

1. Every model request from this agent flows through the router.
2. If the request has **no image**, it is routed to the configured **text model** (or the session's selected model if none is configured).
3. If the request **contains an image**, the router first sends the image (plus the user's text) to the configured **vision model**, which returns a written analysis. That analysis is then handed to the **text model** along with the original request — the text model never sees the raw image.

## Implications for you

- **Images are handled for you.** When you attach or reference a screenshot, it is described by the vision model and the description is what the text model reasons over. Do not try to "force" the vision model yourself or send raw image bytes through the `pwsh`/`bash` tools to reverse-engineer a screenshot — the router already produces the analysis.
- **The text stage may be a text-only model.** Because the router converts images into a written analysis before the text model sees them, you can pair a strong text-only model with a separate vision model.
- **Config lives in settings, not in the prompt.** The vision/text model pair is chosen in the deployment's settings (`$DSH_HOME/settings.yaml`, `vision-router:` section) or the composition config. If you need a different pair, say so to the user rather than improvising.

## When the router is not active

If no vision target is configured, the router passes every request through unchanged — the agent acts as if the router is absent. If a request contains an image and the vision model is not configured, expect an error rather than a silent degrade.
