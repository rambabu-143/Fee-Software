import { Button, Checkbox, Form, Input, Modal, Table, Tag, message } from 'antd'
import { useState } from 'react'
import { api } from '../api'
import { useSelection, type Year } from '../selection'

export default function Years() {
  const { years, reload } = useSelection()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  async function create(values: Omit<Year, 'id'>) {
    try {
      await api('/years', { method: 'POST', body: JSON.stringify(values) })
      setOpen(false)
      form.resetFields()
      reload()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>
        Add academic year
      </Button>
      <Table rowKey="id" dataSource={years} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Year', dataIndex: 'label', render: (v, r) => <>{v} {r.isCurrent && <Tag color="green">Current</Tag>}</> },
        { title: 'Start', dataIndex: 'startDate', render: (v: string) => v.slice(0, 10) },
        { title: 'End', dataIndex: 'endDate', render: (v: string) => v.slice(0, 10) },
      ]} />
      <Modal title="Add academic year" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="label" label="Label (e.g. 2027-28)" rules={[{ required: true, pattern: /^\d{4}-\d{2}$/ }]}>
            <Input />
          </Form.Item>
          <Form.Item name="startDate" label="Start date" rules={[{ required: true }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="endDate" label="End date" rules={[{ required: true }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="isCurrent" valuePropName="checked">
            <Checkbox>Make this the current year</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
