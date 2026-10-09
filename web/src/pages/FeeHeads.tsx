import { Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Gate } from '../session'
import { useSelection } from '../selection'

type FeeHead = { id: number; name: string; type: string }
export const FEE_HEAD_TYPES = ['ADMISSION', 'ANNUAL', 'MONTHLY', 'REFUNDABLE', 'OPTIONAL']

export default function FeeHeads() {
  const { schoolId } = useSelection()
  const [rows, setRows] = useState<FeeHead[]>([])
  const [editing, setEditing] = useState<Partial<FeeHead> | null>(null)
  const [form] = Form.useForm()

  const run = (p: Promise<unknown>) => p.then(load).catch((e) => message.error(e.message))
  const load = async () => {
    if (schoolId) setRows(await api<FeeHead[]>(`/fee-heads?schoolId=${schoolId}`))
  }
  useEffect(() => void run(Promise.resolve()), [schoolId])

  function save(values: Omit<FeeHead, 'id'>) {
    const req = editing?.id
      ? api(`/fee-heads/${editing.id}`, { method: 'PATCH', body: JSON.stringify(values) })
      : api('/fee-heads', { method: 'POST', body: JSON.stringify({ ...values, schoolId }) })
    run(req.then(() => setEditing(null)))
  }

  return (
    <>
      <Gate cap="feeHeads.write"><Button type="primary" style={{ marginBottom: 16 }} onClick={() => {
        form.resetFields()
        setEditing({})
      }}>
        Add fee head
      </Button></Gate>
      <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Fee head', dataIndex: 'name' },
        { title: 'Type', dataIndex: 'type', render: (t: string) => <Tag>{t}</Tag> },
        {
          title: '',
          render: (_, r) => (
            <Space>
              <Gate cap="feeHeads.write" hide><Button size="small" onClick={() => {
                form.setFieldsValue(r)
                setEditing(r)
              }}>Edit</Button></Gate>
              <Gate cap="feeHeads.write" hide><Popconfirm title="Delete this fee head?" onConfirm={() => run(api(`/fee-heads/${r.id}`, { method: 'DELETE' }))}>
                <Button size="small" danger>Delete</Button>
              </Popconfirm></Gate>
            </Space>
          ),
        },
      ]} />
      <Modal title={editing?.id ? 'Edit fee head' : 'Add fee head'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Type" rules={[{ required: true }]}>
            <Select options={FEE_HEAD_TYPES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
