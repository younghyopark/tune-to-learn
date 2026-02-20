import trimesh
import numpy as np
from PIL import Image

# Define materials and their corresponding texture files
materials = {
    "red": "red_texture.png",
    "orange": "orange_texture.png",
    "blue": "blue_texture.png",
    "green": "green_texture.png",
    "white": "white_texture.png",
    "yellow": "yellow_texture.png",
    "red_white": "red_white_texture.png",
    # Add other material to texture mappings as needed
}

# Function to write an OBJ file
def write_obj(vertices, faces, material_name, obj_filename):
    with open(obj_filename, 'w') as obj_file:
        obj_file.write(f"o Cubelet\n")
        for v in vertices:
            obj_file.write(f"v {v[0]} {v[1]} {v[2]}\n")
        
        obj_file.write(f"usemtl {material_name}\n")
        for f in faces:
            obj_file.write(f"f {f[0]+1} {f[1]+1} {f[2]+1}\n")

# Function to write an MTL file
def write_mtl(material_name, texture_file, mtl_filename):
    with open(mtl_filename, 'w') as mtl_file:
        mtl_file.write(f"newmtl {material_name}\n")
        mtl_file.write(f"map_Kd {texture_file}\n")

# Load STL file and extract vertices and faces
stl_filename = 'cubelet.stl'
mesh = trimesh.load(stl_filename)

vertices = mesh.vertices
faces = mesh.faces

# Loop through each material and generate corresponding OBJ and MTL files
for material_name, texture_file in materials.items():
    obj_filename = f'{material_name}.obj'
    mtl_filename = f'{material_name}.mtl'
    
    # Write the OBJ file
    write_obj(vertices, faces, material_name, obj_filename)
    
    # Write the MTL file
    write_mtl(material_name, texture_file, mtl_filename)

    # Optionally, if you want to save the OBJ with reference to MTL in the same directory:
    with open(obj_filename, 'a') as obj_file:
        obj_file.write(f"mtllib {mtl_filename}\n")

print("OBJ and MTL files created successfully.")
