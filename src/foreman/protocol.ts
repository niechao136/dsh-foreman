/** Re-exported so the hub and the device speak one definition, not two copies. */
export {
  FOREMAN_PROTOCOL_VERSION, MAX_FRAME_BYTES, FrameError, FrameDedupe, encodeFrame, parseFrame,
} from 'dsh-foreman-node/protocol'
export type {
  Frame, Root, FrameAttachment, NodeReportState, HelloFrame, HeartbeatFrame, AssignFrame, InputFrame,
  StopFrame, AcceptedFrame, ReportFrame, AckFrame, ErrorFrame,
} from 'dsh-foreman-node/protocol'