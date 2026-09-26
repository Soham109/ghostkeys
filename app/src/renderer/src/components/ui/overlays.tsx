import * as React from 'react'
import {
  Select as SelectPrimitive,
  DropdownMenu as DropdownPrimitive,
  Dialog as DialogPrimitive,
  AlertDialog as AlertPrimitive,
  Popover as PopoverPrimitive
} from 'radix-ui'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

const popSurface =
  'z-50 overflow-hidden rounded-[8px] bg-popover p-1 text-ink shadow-[var(--pop-shadow)] origin-[var(--radix-popper-transform-origin)] ' +
  'data-[state=open]:animate-[pop-in_160ms_var(--ease-snap)]'

// ---------------------------------------------------------------- Select

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value
export const SelectGroup = SelectPrimitive.Group

export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>): React.JSX.Element {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-fill px-2.5 text-left text-[13px] text-ink',
        'shadow-[inset_0_0_0_1px_var(--hairline)] outline-none hover:bg-fill-hover focus-visible:shadow-[inset_0_0_0_1px_var(--ink-3)]',
        'data-[placeholder]:text-ink-3 [&>span]:truncate',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>): React.JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(popSurface, 'max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)]', className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex h-7 cursor-default items-center gap-2 rounded-[5px] pr-7 pl-2 text-[13px] outline-none select-none',
        'data-[highlighted]:bg-fill-active data-[disabled]:opacity-40',
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>): React.JSX.Element {
  return <SelectPrimitive.Label className={cn('label-mono px-2 pt-2 pb-1', className)} {...props} />
}

export function SelectSeparator(): React.JSX.Element {
  return <SelectPrimitive.Separator className="my-1 h-px bg-hairline" />
}

// ---------------------------------------------------------------- Dropdown menu

export const Menu = DropdownPrimitive.Root
export const MenuTrigger = DropdownPrimitive.Trigger

export function MenuContent({ className, ...props }: React.ComponentProps<typeof DropdownPrimitive.Content>): React.JSX.Element {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content sideOffset={4} className={cn(popSurface, 'min-w-44', className)} {...props} />
    </DropdownPrimitive.Portal>
  )
}

export function MenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof DropdownPrimitive.Item> & { destructive?: boolean }): React.JSX.Element {
  return (
    <DropdownPrimitive.Item
      className={cn(
        'flex h-7 cursor-default items-center gap-2 rounded-[5px] px-2 text-[13px] outline-none select-none data-[highlighted]:bg-fill-active',
        '[&_svg]:size-3.5 [&_svg]:text-ink-2',
        destructive && 'text-danger [&_svg]:text-danger',
        className
      )}
      {...props}
    />
  )
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownPrimitive.Label>): React.JSX.Element {
  return <DropdownPrimitive.Label className={cn('label-mono px-2 pt-1.5 pb-1', className)} {...props} />
}

export function MenuSeparator(): React.JSX.Element {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-hairline" />
}

// ---------------------------------------------------------------- Popover

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({ className, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>): React.JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content sideOffset={4} align="start" className={cn(popSurface, 'p-0', className)} {...props} />
    </PopoverPrimitive.Portal>
  )
}

// ---------------------------------------------------------------- Sheet (side panel) and Dialog

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 460
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[var(--overlay)] data-[state=open]:animate-[fade-in_200ms_var(--ease-snap)] data-[state=closed]:animate-[fade-out_160ms_var(--ease-snap)]" />
        <DialogPrimitive.Content
          style={{ width }}
          className={cn(
            'fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-bg shadow-[-1px_0_0_var(--hairline)] outline-none',
            'data-[state=open]:animate-[sheet-in_280ms_var(--ease-out)] data-[state=closed]:animate-[sheet-out_200ms_var(--ease-snap)]'
          )}
        >
          <div className="drag flex h-[52px] shrink-0 items-center justify-between pr-3 pl-6">
            <DialogPrimitive.Title className="text-[15px] font-medium">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="no-drag" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>
          {description ? (
            <DialogPrimitive.Description className="-mt-2 px-6 pb-3 text-[12px] text-ink-2">{description}</DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="flex shrink-0 items-center gap-2 px-6 py-3 shadow-[0_-1px_0_var(--hairline)]">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  className
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[var(--overlay)] data-[state=open]:animate-[fade-in_200ms_var(--ease-snap)]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[12px] bg-popover shadow-[var(--pop-shadow)] outline-none',
            'data-[state=open]:animate-[dialog-in_240ms_var(--ease-out)]',
            className
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Confirm({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  body: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className="fixed inset-0 z-[60] bg-[var(--overlay)] data-[state=open]:animate-[fade-in_200ms_var(--ease-snap)]" />
        <AlertPrimitive.Content className="fixed top-1/2 left-1/2 z-[61] w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-[12px] bg-popover p-5 shadow-[var(--pop-shadow)] data-[state=open]:animate-[dialog-in_240ms_var(--ease-out)]">
          <AlertPrimitive.Title className="text-[15px] font-medium">{title}</AlertPrimitive.Title>
          <AlertPrimitive.Description className="mt-2 text-[13px] leading-relaxed text-ink-2">{body}</AlertPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertPrimitive.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertPrimitive.Cancel>
            <AlertPrimitive.Action asChild>
              <Button variant="primary" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertPrimitive.Action>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  )
}
