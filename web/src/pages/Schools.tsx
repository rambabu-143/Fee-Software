import { Button, Form, Input, Modal, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'

type School = { id: number; code: string; name: string }

export default function Schools() {
  const [rows, setRows] = useState<School[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

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

  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>
        Add school
      </Button>
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: 'Code', dataIndex: 'code' },
        { title: 'Name', dataIndex: 'name' },
      ]} />
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
    </>
  )
}
