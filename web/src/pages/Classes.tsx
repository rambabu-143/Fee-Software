import { Button, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Section = { id: number; name: string }
type Standard = { id: number; name: string; sortOrder: number; sections: Section[] }

export default function Classes() {
  const { schoolId } = useSelection()
  const [rows, setRows] = useState<Standard[]>([])
  const [editing, setEditing] = useState<Partial<Standard> | null>(null)
  const [form] = Form.useForm()

  const run = (p: Promise<unknown>) => p.then(load).catch((e) => message.error(e.message))
  const load = async () => {
    if (schoolId) setRows(await api<Standard[]>(`/standards?schoolId=${schoolId}`))
  }
  useEffect(() => void run(Promise.resolve()), [schoolId])

  function save(values: { name: string; sortOrder: number }) {
    const req = editing?.id
      ? api(`/standards/${editing.id}`, { method: 'PATCH', body: JSON.stringify(values) })
      : api('/standards', { method: 'POST', body: JSON.stringify({ ...values, schoolId }) })
    run(req.then(() => setEditing(null)))
  }

  function addSection(standardId: number, input: HTMLInputElement) {
    const name = input.value.trim()
    if (!name) return
    input.value = ''
    run(api('/sections', { method: 'POST', body: JSON.stringify({ standardId, name }) }))
  }

  return (
    <>
      <Button type="primary" style={{ marginBottom: 16 }} onClick={() => {
        form.setFieldsValue({ name: '', sortOrder: rows.length })
        setEditing({})
      }}>
        Add class
      </Button>
      <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Order', dataIndex: 'sortOrder', width: 80 },
        { title: 'Class', dataIndex: 'name' },
        {
          title: 'Sections',
          render: (_, r) => (
            <Space wrap>
              {r.sections.map((s) => (
                <Tag key={s.id} closable onClose={(e) => {
                  e.preventDefault()
                  run(api(`/sections/${s.id}`, { method: 'DELETE' }))
                }}>
                  {s.name}
                </Tag>
              ))}
              <Input size="small" placeholder="+ Section, Enter" style={{ width: 130 }}
                onPressEnter={(e) => addSection(r.id, e.currentTarget)} />
            </Space>
          ),
        },
        {
          title: '',
          render: (_, r) => (
            <Space>
              <Button size="small" onClick={() => {
                form.setFieldsValue(r)
                setEditing(r)
              }}>Edit</Button>
              <Popconfirm title="Delete this class?" onConfirm={() => run(api(`/standards/${r.id}`, { method: 'DELETE' }))}>
                <Button size="small" danger>Delete</Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]} />
      <Modal title={editing?.id ? 'Edit class' : 'Add class'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Class name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="sortOrder" label="Display order" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
