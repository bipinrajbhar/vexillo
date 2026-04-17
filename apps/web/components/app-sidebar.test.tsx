/// <reference types="@testing-library/jest-dom/vitest" />
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AppSidebar } from './app-sidebar'

const mockOrg = { id: '1', name: 'Acme', slug: 'acme', status: 'active' as const }

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, params }: { to: string; children?: React.ReactNode; params?: Record<string, string> }) => (
    <a href={params ? to.replace(/\$(\w+)/g, (_, k) => params[k] ?? '') : to}>{children}</a>
  ),
  useRouterState: () => ({ location: { pathname: '/org/acme/flags' } }),
}))

vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuButton: ({ children, render: renderProp }: { children: React.ReactNode; render?: React.ReactElement; isActive?: boolean; className?: string }) => {
    if (renderProp) {
      const to: string = renderProp.props.to ?? '#'
      const params: Record<string, string> | undefined = renderProp.props.params
      const href = params ? to.replace(/\$(\w+)/g, (_, k) => params[k] ?? '') : to
      return <a href={href}>{children}</a>
    }
    return <button>{children}</button>
  },
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
}))

vi.mock('@/components/sign-out-button', () => ({
  SignOutButton: () => <button>Sign out</button>,
}))

describe('AppSidebar', () => {
  it('does not show admin links when isSuperAdmin is false', () => {
    render(
      <AppSidebar org={mockOrg} role="viewer" userEmail="user@example.com" isSuperAdmin={false} />
    )
    expect(screen.queryByText('Organizations')).toBeNull()
  })

  it('does not show admin links when isSuperAdmin is omitted', () => {
    render(
      <AppSidebar org={mockOrg} role="viewer" userEmail="user@example.com" />
    )
    expect(screen.queryByText('Organizations')).toBeNull()
  })

  it('shows Organizations link when isSuperAdmin is true', () => {
    render(
      <AppSidebar org={mockOrg} role="viewer" userEmail="user@example.com" isSuperAdmin={true} />
    )
    const orgsLink = screen.getByRole('link', { name: /organizations/i })
    expect(orgsLink).toBeInTheDocument()
    expect(orgsLink).toHaveAttribute('href', '/org/acme/admin')
  })
})
