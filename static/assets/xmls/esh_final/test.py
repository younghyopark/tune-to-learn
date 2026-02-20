import mujoco
import mujoco.viewer

# Load URDF instead of MJCF
model = mujoco.MjModel.from_xml_path("hand.urdf")
data = mujoco.MjData(model)

# Open interactive viewer
with mujoco.viewer.launch_passive(model, data) as viewer:
    while viewer.is_running():
        mujoco.mj_step(model, data)
