import { Button, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

export type Installment = { id: number; number: number; label: string; dueDate: string; fineStartDate: string | null; finePerDay: string }
const day = (v?: string | null) => v?.slice(0, 10) ?? ''

export default function Installments() {
  const { schoolId, yearId } = useSelection()
  const [rows, setRows] = useState<Installment[]>([])
  const [editing, setEditing] = useState<Partial<Installment> | null>(null)
  const [form] = Form.useForm()

  const run = (p: Promise<unknown>) => p.then(load).catch((e) => message.error(e.message))
  const load = async () => {
    if (schoolId && yearId) setRows(await api<Installment[]>(`/installments?schoolId=${schoolId}&yearId=${yearId}`))
  }
  useEffect(() => void run(Promise.resolve()), [schoolId, yearId])

  function save(values: Omit<Installment, 'id'>) {
    const body = { ...values, fineStartDate: values.fineStartDate || null, finePerDay: Number(values.finePerDay ?? 0) }
    const req = editing?.id
      ? api(`/installments/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      : api('/installments', { method: 'POST', body: JSON.stringify({ ...body, schoolId, yearId }) })
    run(req.then(() => setEditing(null)))
  }

  return (
    <>
      <Button type="primary" style={{ marginBottom: 16 }} onClick={() => {
        form.setFieldsValue({ number: rows.length + 1, label: '', dueDate: '', fineStartDate: '', finePerDay: 0 })
        setEditing({})
      }}>
        Add installment
      </Button>
      <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'No.', dataIndex: 'number', width: 60 },
        { title: 'Label', dataIndex: 'label' },
        { title: 'Due date', dataIndex: 'dueDate', render: day },
        { title: 'Fine from', dataIndex: 'fineStartDate', render: day },
        { title: 'Fine / day', dataIndex: 'finePerDay' },
        {
          title: '',
          render: (_, r) => (
            <Space>
              <Button size="small" onClick={() => {
                form.setFieldsValue({ ...r, dueDate: day(r.dueDate), fineStartDate: day(r.fineStartDate), finePerDay: Number(r.finePerDay) })
                setEditing(r)
              }}>Edit</Button>
              <Popconfirm title="Delete this installment?" onConfirm={() => run(api(`/installments/${r.id}`, { method: 'DELETE' }))}>
                <Button size="small" danger>Delete</Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]} />
      <Modal title={editing?.id ? 'Edit installment' : 'Add installment'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="number" label="Number" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="label" label="Label" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="dueDate" label="Due date" rules={[{ required: true }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="fineStartDate" label="Fine starts from (optional)">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="finePerDay" label="Fine per day (₹)">
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
