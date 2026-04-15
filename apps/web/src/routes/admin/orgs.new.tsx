import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'

/** Legacy URL: opens the create flow on the organizations page. */
export function AdminOrgsNewPage() {
  const navigate = useNavigate()
  const { slug } = useParams({ strict: false }) as { slug: string }

  useEffect(() => {
    navigate({ to: '/org/$slug/admin', params: { slug }, search: { newOrg: '1' }, replace: true })
  }, [navigate, slug])

  return null
}
