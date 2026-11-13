import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, X } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import type { Status } from '../shared/api'
import { useTranslation } from './i18n'
import { statusLabel } from './store'

export function Button({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={'button ' + className} {...props}>{children}</button>
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Button title={label} aria-label={label} className={'icon-button ' + className} {...props}>{children}</Button>
}

export function Select({ children, className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className={'select-wrap ' + className}><select {...props}>{children}</select><ChevronDown size={13} /></span>
}

export function StatusBadge({ status = 'stopped', showDot = true }: { status?: Status; showDot?: boolean }) {
  const t = useTranslation()
  return <span className={'status-badge ' + status}>{showDot && <i className={'status-dot ' + status} />}{statusLabel(status, t)}</span>
}

export function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const t = useTranslation()
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog" {...(!description && { 'aria-describedby': undefined })}>
        <header className="dialog-header">
          <div><Dialog.Title>{title}</Dialog.Title>
            {description && <Dialog.Description>{description}</Dialog.Description>}
          </div>
          <Dialog.Close asChild><IconButton label={t('关闭', 'Close')}><X size={17} /></IconButton></Dialog.Close>
        </header>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    {text && <p>{text}</p>}
    {action}
  </div>
}
