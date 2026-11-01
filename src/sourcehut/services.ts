/** The Sourcehut services this provider talks to. */
export const SERVICES = ['meta', 'git', 'todo', 'lists', 'builds'] as const
export type Service = typeof SERVICES[number]

/** The host of one service on an instance, such as `git.sr.ht` for `sr.ht`. */
export function serviceHost(instance: string, service: Service): string {
  return `${service}.${instance}`
}

/** The `https://` root of one service on an instance. */
export function serviceUrl(instance: string, service: Service): string {
  return `https://${serviceHost(instance, service)}`
}

/** The instance root for a host: strips a service subdomain, so `git.sr.ht` and `sr.ht` both give `sr.ht`. */
export function sourcehutInstance(host: string): string {
  const service = SERVICES.find(candidate => host.startsWith(`${candidate}.`))
  return service ? host.slice(service.length + 1) : host
}
