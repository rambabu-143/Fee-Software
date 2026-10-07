import { Button, Input, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Entry = {
  id: number; username: string; entity: string; entityId: number | null; action: string
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; createdAt: string
}
const PAGE = 50

// Side-by-side before/after with the changed keys highlighted.
function Diff({ before, after }: Pick<Entry, 'before' | 'after'>) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  if (!keys.length) return <i>No payload recorded</i>
  const show = (v: unknown) => (v === undefined ? '' : JSON.stringify(v))
  return (
    <Table size="small" pagination={false} rowKey="k" dataSource={keys.map((k) => ({ k, b: before?.[k], a: after?.[k] }))} columns={[
      { title: 'Field', dataIndex: 'k', width: 200 },
      { title: 'Before', dataIndex: 'b', render: show },
      { title: 'After', dataIndex: 'a', render: show },
    ]} onRow={(r) => ({ style: JSON.stringify(r.b) !== JSON.stringify(r.a) ? { background: 'rgba(250,173,20,.15)' } : {} })} />
  )
}

export default function Audit() {
  const { schoolId } = useSelection()
  const [entity, setEntity] = useState('')
  const [entityId, setEntityId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ total: number; rows: Entry[] }>({ total: 0, rows: [] })
  const [loading, setLoading] = useState(false)

  async function load(p = page) {
    const qs = new URLSearchParams({ take: String(PAGE), skip: String((p - 1) * PAGE) })
    if (schoolId) qs.set('schoolId', String(schoolId))
    if (entity) qs.set('entity', entity)
    if (entityId) qs.set('entityId', entityId)
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    setLoading(true)
    try {
      setData(await api(`/audit?${qs}`))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load(1)
    setPage(1)
  }, [schoolId])

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input placeholder="Entity (e.g. students)" value={entity} onChange={(e) => setEntity(e.target.value)} style={{ width: 190 }} />
        <Input placeholder="Entity id" value={entityId} onChange={(e) => setEntityId(e.target.value.replace(/\D/g, ''))} style={{ width: 110 }} />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
        <Button type="primary" loading={loading} onClick={() => (setPage(1), load(1))}>Filter</Button>
      </Space>
      <Table rowKey="id" size="small" loading={loading} dataSource={data.rows} scroll={{ x: true }}
        pagination={{ current: page, pageSize: PAGE, total: data.total, showSizeChanger: false, onChange: (p) => (setPage(p), load(p)) }}
        expandable={{ expandedRowRender: (r) => <Diff before={r.before} after={r.after} />, rowExpandable: (r) => !!(r.before || r.after) }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', render: (v) => new Date(v).toLocaleString() },
          { title: 'User', dataIndex: 'username' },
          { title: 'Action', dataIndex: 'action', render: (v) => <Tag color={v === 'DELETE' ? 'red' : v === 'CREATE' ? 'green' : 'blue'}>{v}</Tag> },
          { title: 'Entity', dataIndex: 'entity' },
          { title: 'Id', dataIndex: 'entityId' },
        ]} />
    </>
  )
}
