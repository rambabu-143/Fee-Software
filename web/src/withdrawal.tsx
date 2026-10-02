import { Form, Input, Modal, message } from 'antd'
import { useState } from 'react'
import { api } from './api'

const today = () => new Date().toISOString().slice(0, 10)

// Records a student leaving: they become inactive and installments due after the date stop being charged.
export function WithdrawModal({ student, yearId, onClose, onDone }: {
  student: { id: number; name: string } | null; yearId?: number; onClose: () => void; onDone: () => void
}) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  async function save(v: { date: string; reason: string; remarks?: string }) {
    setSaving(true)
    try {
      await api(`/students/${student!.id}/withdrawal`, {
        method: 'POST',
        body: JSON.stringify({ yearId, date: v.date, reason: v.reason, remarks: v.remarks || undefined }),
      })
      message.success('Withdrawal recorded')
      form.resetFields()
      onDone()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={student && `Withdraw · ${student.name}`} open={!!student} onCancel={onClose} onOk={form.submit}
      okText="Withdraw" okButtonProps={{ danger: true }} confirmLoading={saving}>
      <Form form={form} layout="vertical" onFinish={save} initialValues={{ date: today() }}>
        <Form.Item name="date" label="Date of leaving" rules={[{ required: true }]}>
          <Input type="date" max={today()} style={{ width: 180 }} />
        </Form.Item>
        <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 2 }]}><Input /></Form.Item>
        <Form.Item name="remarks" label="Remarks"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  )
}
