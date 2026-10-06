---
title: Providers
navigation: false
description: Every supported forge, with its import path and factories.
icon: i-lucide-server
---

Each provider turns one forge's API into the shared [data model](/concepts/data-model), and declares what it supports in its [capabilities](/concepts/capabilities).

| Forge | Import | Factories |
| --- | --- | --- |
| [GitHub and GitHub Enterprise Server](/providers/github) | `forges/github` | `github`, `githubLite` |
| [GitLab](/providers/gitlab) | `forges/gitlab` | `gitlab`, `gitlabLite` |
| [Bitbucket Cloud](/providers/bitbucket) | `forges/bitbucket` | `bitbucket`, `bitbucketLite` |
| [Forgejo and Codeberg](/providers/forgejo) | `forges/forgejo` | `forgejo`, `forgejoLite` |
| [Gitea](/providers/gitea) | `forges/gitea` | `gitea`, `giteaLite` |
| [Gitee](/providers/gitee) | `forges/gitee` | `gitee`, `giteeLite` |
| [Azure DevOps](/providers/azure-devops) | `forges/azure-devops` | `azureDevOps`, `azureDevOpsLite` |
| [Cursor Origin](/providers/cursor-origin) | `forges/cursor-origin` | `cursorOrigin`, `cursorOriginLite` |
| [Tangled](/providers/tangled) | `forges/tangled` | `tangled`, `tangledLite` |
| [pushin.eu](/providers/pushin) | `forges/pushin` | `pushin` |

Each provider page covers authentication, the instance URL, behaviour specific to that forge, webhook verification and the full capability list.

For a side-by-side view, see the [capability matrix](/reference/capability-matrix).
