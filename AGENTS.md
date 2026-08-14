# AGENTS.md — mistral-vibe (extension pi)

Extension pi qui enregistre un provider `mistral-vibe` parlant à l'API Mistral
avec le même contrat wire que le harness `mistral-vibe` (headers, reasoning,
modèles), en lisant sa config depuis l'installation locale de vibe.

## Règles

- **Parité wire = invariant n°1.** Ne jamais envoyer de champ/header que vibe
  n'envoie pas (en particulier : pas de `prompt_cache_key`, `reasoning_effort`
  pour TOUS les modèles thinking, température forcée à 1.0 quand reasoning
  actif, `x-affinity` toujours, `user-agent:
  mistral-client-python/Mistral-Vibe/<version>`). Toute dérive doit être
  documentée explicitement dans README.md.
- **Source de vérité du comportement** : le code local de vibe
  (`~/.local/share/uv/tools/mistral-vibe/lib/*/site-packages/vibe/`,
  surtout `core/llm/backend/mistral.py`, `utils/http.py`) et le SDK
  `mistralai`. Si le comportement de vibe change, le provider doit suivre.
- **`wire.ts` reste sans import pi-ai** : c'est la couche testable du contrat
  HTTP. Ne pas y introduire de dépendance.
- **Config** : `~/.vibe/config.toml` (modèles/providers) et `~/.vibe/.env`
  (clé API) sont lus au chargement ; `/reload` dans pi relit tout. Ne jamais
  committer de clé API ni de secrets.
- **Seuls les modèles du backend mistral** de la config vibe sont enregistrés
  (pas deepseek/llamacpp).
- **Fichiers** : `index.ts` (entrée), `stream.ts` (streamSimple),
  `vibe-config.ts` (lecture config), `wire.ts` (contrat pur), `README.md`,
  `AGENTS.md`/`CLAUDE.md`.
- **Tests/validation** : `pi --list-models` (chargement + modèles),
  `/mistral-vibe-status`, hooks `before_provider_headers` /
  `before_provider_request` pour inspecter le wire. Un test réel consomme du
  crédit API → demander l'accord de l'utilisateur avant.

## Vérifs rapides

```bash
pi --list-models | grep mistral-vibe   # chargement ok + modèles
# dans pi : /mistral-vibe-status
```
