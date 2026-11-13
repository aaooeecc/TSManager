import { translation } from './locale'
import { useDesk } from './store'

export type { Translate } from './locale'
export const useTranslation = () => translation(useDesk((state) => state.settings.language))
