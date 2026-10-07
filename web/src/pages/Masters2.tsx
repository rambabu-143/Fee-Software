import { Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Occupation = { id: number; name: string; parentId: number | null }
type Subject = { id: number; name: string; kind: 'LANGUAGE' | 'ADDITIONAL' | 'CORE' }
const kinds = ['LANGUAGE', 'ADDITIONAL', 'CORE'].map((k) => ({ value: k, label: k[0] + k.slice(1).toLowerCase() }))

// One small CRUD card for either catalogue; `fields` are the extra inputs besides name.
function Catalogue<T extends { id: number; name: string }>(props: {
  title: string; path: string; schoolId?: number; columns: { title: string; render: (r: T) => React.ReactNode }[]
  fields: React.ReactNode; initial: Partial<T>; toBody: (v: Record<string, unknown>) => object
}) {
  const [rows, setRows] = useState<T[]>([])
  const [editing, setEditing] = useState<Partial<T> | null>(null)
  const [form] = Form.useForm()
  const load = () => props.schoolId ? api<T[]>(`${props.path}?schoolId=${props.schoolId}`).then(setRows).catch((e) => message.error(e.message)) : undefined
  useEffect(() => void load(), [props.schoolId])

  async function save(v: Record<string, unknown>) {
    try {
      const body = props.toBody(v)
      if (editing?.id) await api(`${props.path}/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      else await api(props.path, { method: 'POST', body: JSON.stringify({ ...body, schoolId: props.schoolId }) })
      setEditing(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  async function remove(id: number) {
    try {
      await api(`${props.path}/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      message.error((e as Error).message) // 409 "in use" comes through verbatim
    }
  }
  return (
    <Card title={props.title} extra={<Button type="primary" onClick={() => { form.resetFields(); form.setFieldsValue(props.initial); setEditing({}) }}>Add</Button>}>
      <Table size="small" rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: 'Name', dataIndex: 'name' }, ...props.columns.map((c) => ({ title: c.title, render: (_: unknown, r: T) => c.render(r) })),
        { title: '', render: (_: unknown, r: T) => (
          <Space>
            <Button size="small" onClick={() => { form.resetFields(); form.setFieldsValue(r); setEditing(r) }}>Edit</Button>
            <Popconfirm title="Delete?" onConfirm={() => remove(r.id)}><Button size="small" danger>Delete</Button></Popconfirm>
          </Space>
        ) },
      ]} />
      <Modal title={`${editing?.id ? 'Edit' : 'Add'} ${props.title.toLowerCase()}`} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          {props.fields}
        </Form>
      </Modal>
    </Card>
  )
}

export default function Masters2() {
  const { schoolId } = useSelection()
  const [parents, setParents] = useState<Occupation[]>([])
  useEffect(() => {
    if (schoolId) api<Occupation[]>(`/occupations?schoolId=${schoolId}`).then((o) => setParents(o.filter((x) => !x.parentId))).catch(() => undefined)
  }, [schoolId])
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Catalogue<Occupation> title="Occupations" path="/occupations" schoolId={schoolId} initial={{}}
        columns={[{ title: 'Sub-category of', render: (r) => parents.find((p) => p.id === r.parentId)?.name ?? '' }]}
        fields={<Form.Item name="parentId" label="Sub-category of (optional)"><Select allowClear options={parents.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item>}
        toBody={(v) => ({ name: v.name, ...(v.parentId ? { parentId: v.parentId } : {}) })} />
      <Catalogue<Subject> title="Subjects" path="/subjects" schoolId={schoolId} initial={{ kind: 'LANGUAGE' }}
        columns={[{ title: 'Kind', render: (r) => r.kind }]}
        fields={<Form.Item name="kind" label="Kind" rules={[{ required: true }]}><Select options={kinds} /></Form.Item>}
        toBody={(v) => ({ name: v.name, kind: v.kind })} />
    </Space>
  )
}
