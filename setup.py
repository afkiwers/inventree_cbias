# -*- coding: utf-8 -*-

import setuptools

from inventree_cbias.version import CBIAS_PLUGIN_VERSION

with open('README.md', encoding='utf-8') as f:
    long_description = f.read()


setuptools.setup(
    name="inventree-cbias-plugin",

    version=CBIAS_PLUGIN_VERSION,

    author="Andre Iwers",

    author_email="iwers11@gmail.com",

    url="https://github.com/afkiwers/inventree_cbias",

    project_urls={
        "GroundTruth": "https://github.com/afkiwers/GroundTruth",
    },

    description="InvenTree plugin: a capacitor's DC-bias (derating) curve on its part page",

    long_description=long_description,

    long_description_content_type='text/markdown',

    keywords="inventree capacitor dc-bias derating mlcc",

    license="MIT",

    packages=setuptools.find_packages(exclude=["tests"]),

    install_requires=[],

    include_package_data=True,

    python_requires=">=3.9",

    entry_points={
        "inventree_plugins": [
            "CbiasPlugin = inventree_cbias.CbiasPlugin:CbiasPlugin"
        ]
    },

    classifiers=[
        "Programming Language :: Python :: 3",
        "Operating System :: OS Independent",
        "Framework :: InvenTree",
    ],
)
