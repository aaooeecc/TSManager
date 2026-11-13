import { defaults, type Language } from '../shared/api'

export type Translate = (chinese: string, english: string) => string

const chinese: Translate = (text) => text
const english: Translate = (_text, text) => text
const languageKey = 'tsmanager.language'

export const translation = (language: Language): Translate => language === 'en' ? english : chinese
export const cachedLanguage = (): Language => localStorage.getItem(languageKey) === 'en' ? 'en' : defaults.language

export function rememberLanguage(language: Language) {
  localStorage.setItem(languageKey, language)
}
