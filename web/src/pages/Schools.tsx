import { Button, Form, Input, Modal, Select, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'

type School = {
  id: number; code: string; name: string
  affiliationNo?: string | null; schoolNo?: string | null; address?: string | null; kind?: 'SENIOR' | 'JUNIOR'
}

export default function Schools() {
  const [rows, setRows] = useState<School[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<School | null>(null)
  const [form] = Form.useForm()
  const [editForm] = Form.useForm()

  const load = () => api<School[]>('/schools').then(setRows).catch((e) => message.error(e.message))
  useEffect(() => {
    load()
  }, [])

  async function create(values: Omit<School, 'id'>) {
    try {
      await api('/schools', { method: 'POST', body: JSON.stringify(values) })
      setOpen(false)
      form.resetFields()
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // Letterhead details printed on TCs and certificates; blank fields are sent as null so they can be cleared.
  async function saveDetails(v: Record<string, string | undefined>) {
    const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'kind' ? x : (x?.trim() || null)]))
    try {
      await api(`/schools/${editing!.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      setEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>
        Add school
      </Button>
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: 'Code', dataIndex: 'code' },
        { title: 'Name', dataIndex: 'name' },
        { title: 'Type', dataIndex: 'kind' },
        { title: 'Affiliation no.', dataIndex: 'affiliationNo' },
        { title: 'School no.', dataIndex: 'schoolNo' },
        { title: 'Address', dataIndex: 'address' },
        {
          title: '', render: (_, r) => (
            <Button size="small" onClick={() => {
              editForm.setFieldsValue({ ...r, kind: r.kind ?? 'SENIOR' })
              setEditing(r)
            }}>Edit letterhead</Button>
          ),
        },
      ]} scroll={{ x: true }} />
      <Modal title="Add school" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="code" label="Code (e.g. DEMO3)" rules={[{ required: true, pattern: /^[A-Z]{2,10}$/ }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={`Letterhead: ${editing?.name ?? ''}`} open={!!editing} onCancel={() => setEditing(null)} onOk={() => editForm.submit()}>
        <Form form={editForm} layout="vertical" onFinish={saveDetails}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="kind" label="Type (picks the TC layout)">
            <Select options={[{ value: 'SENIOR', label: 'Senior' }, { value: 'JUNIOR', label: 'Junior (pre-school)' }]} />
          </Form.Item>
          <Form.Item name="affiliationNo" label="Affiliation no."><Input /></Form.Item>
          <Form.Item name="schoolNo" label="School no."><Input /></Form.Item>
          <Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}
