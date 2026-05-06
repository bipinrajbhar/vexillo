export type Environment = Readonly<{
  id: string
  name: string
  slug: string
}>

export type Flag = Readonly<{
  id: string
  key: string
  name: string
  description: string
  createdAt: Date
  createdByName: string | null
  isOnIn(env: Environment): boolean
  countriesIn(env: Environment): readonly string[]
  isUnrestrictedIn(env: Environment): boolean
}>
