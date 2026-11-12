/** Re-exported so the hub and the device speak one definition, not two copies. */
export {
  FOREMAN_PROTOCOL_VERSION, MAX_FRAME_BYTES, MAX_READ_CHARS, CAPABILITIES, supports, FrameError, FrameDedupe, encodeFrame, parseFrame,
} from 'dsh-foreman-node/protocol'
export type {
  Frame, Root, FrameAttachment, NodeReportState, HelloFrame, HeartbeatFrame, AssignFrame, InputFrame,
  StopFrame, AcceptedFrame, ReportFrame, AckFrame, ErrorFrame, ReadFrame, PartFrame, ReportDetail, Capability,
} from 'dsh-foreman-node/protocol'