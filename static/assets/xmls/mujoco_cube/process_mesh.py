import trimesh
import numpy as np

# Load the mesh
mesh = trimesh.load_mesh("cubelet.stl")

# Scale to meters
mesh.apply_scale(0.001)

# Translate to origin
mesh.apply_translation(-mesh.centroid)

# Define the colors for each face (RGB format, values between 0 and 1)
face_colors = np.array([
    [1, 0, 0, 1],  # Red
    [0, 1, 0, 1],  # Green
    [0, 0, 1, 1],  # Blue
]) * 255 

# Make sure to repeat colors to match the number of faces in your mesh
# Each face must have its own color, or you must repeat colors accordingly
# If the number of faces is not a multiple of 6, you'll need to adjust the repetition
repeated_colors = np.tile(face_colors, (mesh.faces.shape[0] // len(face_colors) + 1, 1))[:mesh.faces.shape[0]]

# Add the colors to the mesh
print(mesh.visual.face_colors.shape)
# # mesh.visual.face_colors[0] = np.array([255, 0, 0, 255])
# # mesh.visual.face_colors[] = np.array([0, 255, 0, 255])
# mesh.visual.face_colors = repeated_colors

# mesh.update_faces()

# print(mesh.visual.vertex_colors.shape)

# mesh.visual.vertex_colors[0] = np.array([255, 0, 0, 255]) # trimesh.visual.random_color()
# mesh.visual.vertex_colors[1] = np.array([255, 0, 0, 255]) # trimesh.visual.random_color()
# mesh.visual.vertex_colors[2] = np.array([255, 0, 0, 255]) # trimesh.visual.random_color()
# mesh.visual.vertex_colors[3] = np.array([255, 0, 0, 255]) # trimesh.visual.random_color()

# for i in range(4, 24): 
#     mesh.visual.vertex_colors[i] = np.array([50, 50, 50, 255]) # trimesh.visual.random_color()

trimesh.Scene(mesh).export("cubelet_with_colors.ply")


# # Print the vertices (optional)
# for vertex in mesh.vertices:
#     print(f"{vertex[0]:.6g} {vertex[1]:.6g} {vertex[2]:.6g}")

    

# # Export to OBJ file with colors
# mesh.export("cubelet_with_colors.obj")

# # Confirm cube size is 0.019
# np.testing.assert_equal(mesh.extents, [0.019] * 3)
